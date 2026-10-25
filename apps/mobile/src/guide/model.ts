import { Lexer, type Token, type Tokens } from 'marked'

import type { ServerMessage, WebPane } from '@commando/protocol'
// shared/guide.ts parses with unified/remark, which the app does not bundle;
// the daemon's snapshot already carries the parsed steps.
import { MAX_GUIDE_NOTE, type GuideSnapshot } from '@commando/guide-types'

export { MAX_GUIDE_NOTE, type GuideSnapshot }
export type GuideStepState = GuideSnapshot['steps'][number]
export type GuideContent = { artifactId: string; file: string }
export type GuideTile = WebPane & { content: { kind: 'guide' } & GuideContent }

export function isGuideTile(tile: WebPane | undefined): tile is GuideTile {
  return tile?.content?.kind === 'guide'
}

/** `/redline/artifacts/<id>/<file>`: the daemon serves the guide's folder read-only, as the desktop tab fetches it. */
export function guideFilePath({ artifactId, file }: GuideContent): string {
  return `/redline/artifacts/${encodeURIComponent(artifactId)}/${file.split('/').map(encodeURIComponent).join('/')}`
}

export function guideApiPath(webPaneId: string, suffix: '' | '/steps' | '/update' | '/reset' = ''): string {
  return `/api/web-panes/${encodeURIComponent(webPaneId)}/guide${suffix}`
}

/**
 * Which part of a guide a socket event invalidates, as the desktop's
 * GuidePane listens: a file change reloads the Markdown and the state, a
 * `guide_state_changed` (a tick, a note or a delivery) only the state.
 */
export function guideEventScope(message: ServerMessage, content: GuideContent): 'all' | 'state' | null {
  if (message.type === 'canvas_changed') {
    if (message.artifactId !== content.artifactId) return null
    return message.changed.some((path) => path === content.file || path === '*') ? 'all' : null
  }
  if (message.type === 'guide_state_changed') return message.artifactId === content.artifactId && message.file === content.file ? 'state' : null
  return null
}

export function guideProgress(steps: readonly Pick<GuideStepState, 'checked'>[]): { done: number; total: number; fraction: number } {
  const done = steps.filter((step) => step.checked).length
  return { done, total: steps.length, fraction: steps.length ? done / steps.length : 0 }
}

export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return 'just now'
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

/** The toolbar's delivery line, worded as the desktop's GuidePane words it. */
export function deliveryLabel(snapshot: Pick<GuideSnapshot, 'waiting' | 'changes' | 'deliveredAt'> | null, now: number): string {
  if (!snapshot) return ''
  if (snapshot.waiting) return 'Sends when the agent is idle…'
  const changes = snapshot.changes.length
  if (changes) return `${changes} unsent change${changes === 1 ? '' : 's'}`
  return snapshot.deliveredAt ? `Agent updated ${ago(snapshot.deliveredAt, now)}` : ''
}

/**
 * A tick shown before the daemon answers. Only the tick moves: the daemon's
 * reply carries the authoritative steps, marks and pending changes.
 */
export function withOptimisticTick(snapshot: GuideSnapshot, id: string, checked: boolean, at = Date.now()): GuideSnapshot {
  return {
    ...snapshot,
    marks: { ...snapshot.marks, [id]: { ...snapshot.marks[id], checked, at } },
    steps: snapshot.steps.map((step) => step.id === id ? { ...step, checked, byUser: true } : step),
  }
}

// ---------------------------------------------------------------------------
// The document: the guide's Markdown as blocks, its steps tied to the daemon's.
// ---------------------------------------------------------------------------

export type CalloutTone = 'info' | 'warn' | 'danger' | 'success'

export type GuideBlock =
  | { kind: 'markdown'; key: string; text: string }
  | { kind: 'code'; key: string; code: string; lang?: string }
  | { kind: 'list'; key: string; ordered: boolean; start: number; items: GuideListItem[] }
  | { kind: 'checkpoint'; key: string; stepId?: string; label: string; sourceChecked: boolean }
  | { kind: 'callout'; key: string; tone: CalloutTone; title?: string; body: GuideBlock[] }
  | { kind: 'details'; key: string; summary: string; body: GuideBlock[] }
  | { kind: 'quote'; key: string; body: GuideBlock[] }

export type GuideListItem = {
  key: string
  /** A `- [ ]` item: the daemon's step id when it was matched. */
  task: boolean
  stepId?: string
  sourceChecked: boolean
  body: GuideBlock[]
}

/** A step as it appears in the Markdown, in document order. */
export type FoundStep = { checkpoint: boolean; label: string; explicitId?: string; sourceChecked: boolean }

const STEP_ID = /\s*\{#([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}\s*$/
const CHECKPOINT_PAIR = /<checkpoint\b([^>]*)>([\s\S]*?)<\/checkpoint\s*>/gi
const CALLOUT_OPEN = /^\s*<callout\b([^>]*)>/i
const CALLOUT_CLOSE = /<\/callout\s*>/i
const DETAILS_OPEN = /^\s*<details\b[^>]*>/i
const DETAILS_CLOSE = /<\/details\s*>/i
const TONES = new Set<CalloutTone>(['info', 'warn', 'danger', 'success'])
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

const squash = (value: string) => value.replace(/\s+/g, ' ').trim()
const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
const stripTags = (value: string) => value.replace(/<\/?[A-Za-z][^>]*>/g, '')

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes)
  return match ? match[1] ?? match[2] ?? match[3] : undefined
}

/** Drop a trailing `{#id}` from a step's first line of text, as the desktop does when it renders. */
export function stripStepId(text: string): string {
  return text.replace(/\s*\{#[A-Za-z0-9][A-Za-z0-9_-]{0,63}\}(?=\s*$)/, '').replace(/\s+$/, '')
}

/**
 * A paragraph's single line breaks are soft in Markdown (the desktop reflows
 * them); native text would keep them, so they become spaces. A hard break
 * (two trailing spaces or a backslash) stays.
 */
export function unwrapSoftBreaks(text: string): string {
  return text.replace(/([^\n])(?<!  |\\)\n(?=[^\n])/g, '$1 ')
}

/** Inline HTML the guide format allows, made readable without a DOM: `<kbd>` reads as code, other tags drop out. */
export function cleanInlineHtml(text: string): string {
  return text.split(/(`+[^`]*`+)/).map((part, index) => index % 2 ? part : part
    .replace(/<kbd>([\s\S]*?)<\/kbd>/gi, (_match, inner: string) => `\`${inner}\``)
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<\/?(?:b|i|em|strong|span|sup|sub|u|mark|small|abbr|summary|details|callout)\b[^>]*>/gi, ''),
  ).join('')
}

function plainText(tokens: readonly Token[] | undefined): string {
  return (tokens ?? []).map((token) => {
    // The daemon's label leaves image alt text out.
    if (token.type === 'image') return ''
    if (token.type === 'text' || token.type === 'codespan' || token.type === 'escape') {
      const nested = (token as Tokens.Text).tokens
      return nested ? plainText(nested) : decode((token as Tokens.Text).text)
    }
    return 'tokens' in token && Array.isArray(token.tokens) ? plainText(token.tokens) : ''
  }).join('')
}

function lex(markdown: string): Token[] {
  try {
    return new Lexer({ gfm: true }).lex(markdown)
  } catch {
    return [{ type: 'paragraph', raw: markdown, text: markdown, tokens: [] } as Tokens.Paragraph]
  }
}

type Builder = { found: FoundStep[]; slots: Array<{ assign: (id: string) => void }> }

/** Split prose holding `<checkpoint>` tags into its text runs and its checkpoint rows. */
function splitCheckpoints(raw: string, key: string, builder: Builder): GuideBlock[] | null {
  // A `<checkpoint>` inside a code span is an example, not a step (remark sees it as code too).
  const masked = raw.replace(/(`+)[\s\S]*?\1/g, (span) => ' '.repeat(span.length))
  if (!/<checkpoint\b/i.test(masked)) return null
  const blocks: GuideBlock[] = []
  let index = 0
  for (const match of masked.matchAll(CHECKPOINT_PAIR)) {
    const before = raw.slice(index, match.index)
    if (before.trim()) blocks.push({ kind: 'markdown', key: `${key}.${blocks.length}`, text: cleanInlineHtml(before.trim()) })
    const attributes = match[1] ?? ''
    const label = squash(stripTags(raw.slice((match.index ?? 0) + match[0].indexOf('>') + 1, (match.index ?? 0) + match[0].length).replace(/<\/checkpoint\s*>$/i, '')))
    const explicit = attribute(attributes, 'id')
    const sourceChecked = /(?:^|\s)done(?=[\s=/]|$)/i.test(attributes)
    const block: Extract<GuideBlock, { kind: 'checkpoint' }> = { kind: 'checkpoint', key: `${key}.${blocks.length}`, label, sourceChecked }
    builder.found.push({ checkpoint: true, label, ...(explicit ? { explicitId: explicit } : {}), sourceChecked })
    builder.slots.push({ assign: (id) => { block.stepId = id } })
    blocks.push(block)
    index = (match.index ?? 0) + match[0].length
  }
  const after = raw.slice(index)
  if (after.trim()) blocks.push({ kind: 'markdown', key: `${key}.${blocks.length}`, text: cleanInlineHtml(after.trim()) })
  return blocks
}

function prose(raw: string, key: string, builder: Builder): GuideBlock[] {
  const split = splitCheckpoints(raw, key, builder)
  if (split) return split
  const text = cleanInlineHtml(raw).replace(/\s+$/, '')
  return text.trim() ? [{ kind: 'markdown', key, text }] : []
}

function hasStep(tokens: readonly Token[] | undefined): boolean {
  return (tokens ?? []).some((token) => {
    if (token.type === 'list') return (token as Tokens.List).items.some((item) => item.task || hasStep(item.tokens))
    if (/<checkpoint\b/i.test(token.raw)) return true
    return 'tokens' in token && Array.isArray(token.tokens) && token.type === 'blockquote' && hasStep(token.tokens)
  })
}

function walk(tokens: readonly Token[], key: string, builder: Builder): GuideBlock[] {
  const blocks: GuideBlock[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const id = `${key}.${index}`
    switch (token.type) {
      case 'space':
      case 'def':
        break
      case 'code': {
        const code = token as Tokens.Code
        blocks.push({ kind: 'code', key: id, code: code.text, ...(code.lang ? { lang: code.lang } : {}) })
        break
      }
      case 'list': {
        const list = token as Tokens.List
        if (!hasStep([list])) { blocks.push({ kind: 'markdown', key: id, text: cleanInlineHtml(list.raw).replace(/\s+$/, '') }); break }
        blocks.push({
          kind: 'list',
          key: id,
          ordered: list.ordered,
          start: typeof list.start === 'number' ? list.start : 1,
          items: list.items.map((item, position) => listItem(item, `${id}.${position}`, builder)),
        })
        break
      }
      case 'blockquote':
        blocks.push(hasStep((token as Tokens.Blockquote).tokens)
          ? { kind: 'quote', key: id, body: walk((token as Tokens.Blockquote).tokens, id, builder) }
          : { kind: 'markdown', key: id, text: cleanInlineHtml(token.raw).replace(/\s+$/, '') })
        break
      case 'html': {
        const raw = token.raw
        const callout = CALLOUT_OPEN.exec(raw)
        const details = callout ? null : DETAILS_OPEN.exec(raw)
        if (callout || details) {
          const close = callout ? CALLOUT_CLOSE : DETAILS_CLOSE
          const opening = (callout ?? details)![0]
          let inner: GuideBlock[]
          let tail: GuideBlock[] = []
          if (close.test(raw)) {
            // Opened and closed in one HTML block: the agent left out the blank lines, so the inside is text.
            const body = raw.slice(raw.indexOf(opening) + opening.length).replace(close, '').replace(/[\s\S]*?<\/summary\s*>/i, '')
            inner = prose(body.trim(), `${id}.0`, builder)
          } else {
            // The body is every token up to the HTML block that closes it.
            let end = index + 1
            while (end < tokens.length && !(tokens[end]!.type === 'html' && close.test(tokens[end]!.raw))) end++
            const rest = raw.slice(raw.indexOf(opening) + opening.length).replace(/[\s\S]*?<\/summary\s*>/i, '')
            inner = prose(rest.trim(), `${id}.head`, builder)
            // Without a close tag of its own (it ended up inside a paragraph), the box holds only its opening block.
            if (end < tokens.length) {
              inner.push(...walk(tokens.slice(index + 1, end), id, builder))
              const closing = tokens[end]!.raw
              const before = closing.slice(0, closing.search(close))
              const after = closing.slice(closing.search(close)).replace(close, '')
              inner.push(...prose(before.trim(), `${id}.tail`, builder))
              tail = prose(after.trim(), `${id}.after`, builder)
              index = end
            }
          }
          if (callout) {
            const attributes = callout[1] ?? ''
            const tone = attribute(attributes, 'tone') as CalloutTone | undefined
            const title = attribute(attributes, 'title')
            blocks.push({ kind: 'callout', key: id, tone: tone && TONES.has(tone) ? tone : 'info', ...(title ? { title: decode(title) } : {}), body: inner })
          } else {
            const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(raw)?.[1]
            blocks.push({ kind: 'details', key: id, summary: squash(stripTags(summary ?? '')) || 'Details', body: inner })
          }
          blocks.push(...tail)
          break
        }
        const split = splitCheckpoints(raw, id, builder)
        if (split) { blocks.push(...split); break }
        const text = squash(stripTags(raw))
        if (text) blocks.push({ kind: 'markdown', key: id, text })
        break
      }
      case 'paragraph':
      case 'text':
        blocks.push(...prose(unwrapSoftBreaks(token.raw), id, builder))
        break
      default:
        blocks.push(...prose(token.raw, id, builder))
    }
  }
  return blocks
}

function listItem(item: Tokens.ListItem, key: string, builder: Builder): GuideListItem {
  const entry: GuideListItem = { key, task: Boolean(item.task), sourceChecked: Boolean(item.checked), body: [] }
  let tokens = item.tokens
  const first = tokens[0]
  if (first && (first.type === 'text' || first.type === 'paragraph')) {
    // The step's name is its first line of text, with the `{#id}` the desktop also hides.
    const label = plainText((first as Tokens.Text).tokens) || (first as Tokens.Text).text
    if (item.task) {
      const explicit = STEP_ID.exec(squash(label))?.[1]
      builder.found.push({ checkpoint: false, label: squash(stripStepId(squash(decode(label)))), ...(explicit ? { explicitId: explicit } : {}), sourceChecked: Boolean(item.checked) })
      builder.slots.push({ assign: (id) => { entry.stepId = id } })
    }
    tokens = [{ ...first, raw: stripStepId(first.raw) } as Token, ...tokens.slice(1)]
  } else if (item.task) {
    builder.found.push({ checkpoint: false, label: '', sourceChecked: Boolean(item.checked) })
    builder.slots.push({ assign: (id) => { entry.stepId = id } })
  }
  entry.body = walk(tokens, key, builder)
  return entry
}

/**
 * Pair each step found in the Markdown with one of the daemon's steps: by
 * explicit `{#id}` first, then by label, and only then by position — and by
 * position only when both parsers count the same number of steps of that kind
 * (task items and checkpoints are numbered separately, as on the desktop). A
 * step that matches nothing renders with its source tick and cannot be ticked:
 * leaving it inert is better than ticking a neighbour.
 */
export function matchSteps(found: readonly FoundStep[], steps: readonly Pick<GuideStepState, 'id' | 'label' | 'checkpoint'>[]): Array<string | undefined> {
  const result: Array<string | undefined> = found.map(() => undefined)
  const used = new Set<string>()
  const claim = (index: number, id: string) => { result[index] = id; used.add(id) }
  const free = (entry: FoundStep, test: (step: Pick<GuideStepState, 'id' | 'label'>) => boolean) =>
    steps.find((step) => step.checkpoint === entry.checkpoint && !used.has(step.id) && test(step))
  found.forEach((entry, index) => {
    const step = entry.explicitId ? free(entry, (candidate) => candidate.id === entry.explicitId) : undefined
    if (step) claim(index, step.id)
  })
  found.forEach((entry, index) => {
    const step = result[index] === undefined ? free(entry, (candidate) => squash(candidate.label) === entry.label) : undefined
    if (step) claim(index, step.id)
  })
  for (const checkpoint of [false, true]) {
    const mine = found.flatMap((entry, index) => entry.checkpoint === checkpoint ? [index] : [])
    const theirs = steps.filter((step) => step.checkpoint === checkpoint)
    if (mine.length !== theirs.length) continue
    mine.forEach((index, position) => {
      const step = theirs[position]!
      if (result[index] === undefined && !used.has(step.id)) claim(index, step.id)
    })
  }
  return result
}

export type GuideDocument = { blocks: GuideBlock[]; found: FoundStep[] }

/** Lex the guide once and tie its task items and checkpoints to the daemon's step ids. */
export function buildGuideDocument(markdown: string, steps: readonly Pick<GuideStepState, 'id' | 'label' | 'checkpoint'>[]): GuideDocument {
  const builder: Builder = { found: [], slots: [] }
  const blocks = walk(lex(markdown), 'g', builder)
  matchSteps(builder.found, steps).forEach((id, index) => { if (id) builder.slots[index]!.assign(id) })
  return { blocks, found: builder.found }
}

/**
 * The guide's steps read from its Markdown alone, for the demo host, which
 * has no daemon to parse it. Ids are the explicit `{#id}`/`id="…"`, else a
 * slug of the label, as shared/guide.ts derives them.
 */
export function outlineGuide(markdown: string): { title: string; steps: Array<Pick<GuideStepState, 'id' | 'label' | 'checkpoint' | 'sourceChecked'>> } {
  const { found } = buildGuideDocument(markdown, [])
  const heading = lex(markdown).find((token) => token.type === 'heading' && (token as Tokens.Heading).depth === 1) as Tokens.Heading | undefined
  const used = new Set<string>()
  const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'step'
  return {
    title: heading ? squash(plainText(heading.tokens)) : '',
    steps: found.map((step) => {
      let id = step.explicitId && !used.has(step.explicitId) ? step.explicitId : slug(step.label)
      for (let n = 2; used.has(id); n++) id = `${slug(step.label).slice(0, 44)}-${n}`
      used.add(id)
      return { id, label: step.label, checkpoint: step.checkpoint, sourceChecked: step.sourceChecked }
    }),
  }
}
