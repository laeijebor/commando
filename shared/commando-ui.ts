/**
 * The `commando-ui` catalog: a fixed set of blocks an agent can write as JSON in a fenced code
 * block. Commando renders them with its own components, so no agent HTML or code ever runs.
 * Validation is hand-rolled and returns fresh objects, so unknown keys never reach a component.
 */

export const COMMANDO_UI_FENCE = 'commando-ui'

export const COMMANDO_UI_LIMITS = {
  source: 20_000,
  blocks: 8,
  id: 64,
  prompt: 300,
  title: 120,
  option: 200,
  options: 8,
  label: 200,
  note: 1000,
  checklistItems: 30,
  columns: 12,
  rows: 50,
  cell: 200,
  stats: 8,
  statLabel: 60,
  statValue: 40,
  statDelta: 30,
} as const

export type StatTone = 'good' | 'bad' | 'neutral'
export type TableCell = string | number

export type CommandoUiBlock =
  | { component: 'choice'; id?: string; prompt: string; options: string[]; multiple: boolean }
  | { component: 'approve'; id?: string; prompt: string; approveLabel: string; rejectLabel: string }
  | { component: 'checklist'; id?: string; title?: string; items: { label: string; done: boolean }[] }
  | { component: 'table'; id?: string; columns: string[]; rows: TableCell[][]; truncatedRows: number }
  | { component: 'stats'; id?: string; items: { label: string; value: string; delta?: string; tone: StatTone }[] }

export type CommandoUiParse =
  | { ok: true; blocks: CommandoUiBlock[] }
  | { ok: false; reason: string; /** The JSON stopped mid-way: a reply that is still streaming. */ incomplete: boolean }

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, where: string, max: number, options: { optional: true }): string | undefined
function text(value: unknown, where: string, max: number, options?: { optional?: false }): string
function text(value: unknown, where: string, max: number, options: { optional?: boolean } = {}): string | undefined {
  if (value === undefined && options.optional) return undefined
  if (typeof value !== 'string' || !value.trim()) fail(`${where} must be a non-empty string`)
  if (value.length > max) fail(`${where} is longer than ${max} characters`)
  return value
}

function list(value: unknown, where: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`)
  if (value.length < min || value.length > max) fail(`${where} needs ${min === max ? min : `${min} to ${max}`} entries`)
  return value
}

function booleanFlag(value: unknown, where: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') fail(`${where} must be true or false`)
  return value
}

function cell(value: unknown, where: string): TableCell {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    if (value.length > COMMANDO_UI_LIMITS.cell) fail(`${where} is longer than ${COMMANDO_UI_LIMITS.cell} characters`)
    return value
  }
  return fail(`${where} must be a string or number`)
}

function statText(value: unknown, where: string, max: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return text(value, where, max)
}

function block(value: unknown, index: number): CommandoUiBlock {
  const at = `block ${index + 1}`
  if (!isRecord(value)) fail(`${at} must be an object`)
  const id = text(value.id, `${at} id`, COMMANDO_UI_LIMITS.id, { optional: true })
  const withId = id === undefined ? {} : { id }
  switch (value.component) {
    case 'choice': {
      const options = list(value.options, `${at} options`, 2, COMMANDO_UI_LIMITS.options).map((option, i) => text(option, `${at} option ${i + 1}`, COMMANDO_UI_LIMITS.option))
      if (new Set(options).size !== options.length) fail(`${at} options must be different`)
      return { component: 'choice', ...withId, prompt: text(value.prompt, `${at} prompt`, COMMANDO_UI_LIMITS.prompt), options, multiple: booleanFlag(value.multiple, `${at} multiple`) }
    }
    case 'approve':
      return {
        component: 'approve', ...withId,
        prompt: text(value.prompt, `${at} prompt`, COMMANDO_UI_LIMITS.prompt),
        approveLabel: text(value.approveLabel, `${at} approveLabel`, COMMANDO_UI_LIMITS.label, { optional: true }) ?? 'Approve',
        rejectLabel: text(value.rejectLabel, `${at} rejectLabel`, COMMANDO_UI_LIMITS.label, { optional: true }) ?? 'Reject',
      }
    case 'checklist': {
      const title = text(value.title, `${at} title`, COMMANDO_UI_LIMITS.title, { optional: true })
      const items = list(value.items, `${at} items`, 1, COMMANDO_UI_LIMITS.checklistItems).map((item, i) => {
        if (!isRecord(item)) fail(`${at} item ${i + 1} must be an object`)
        return { label: text(item.label, `${at} item ${i + 1} label`, COMMANDO_UI_LIMITS.label), done: booleanFlag(item.done, `${at} item ${i + 1} done`) }
      })
      return { component: 'checklist', ...withId, ...(title === undefined ? {} : { title }), items }
    }
    case 'table': {
      const columns = list(value.columns, `${at} columns`, 1, COMMANDO_UI_LIMITS.columns).map((column, i) => text(column, `${at} column ${i + 1}`, COMMANDO_UI_LIMITS.cell))
      // Rows past the cap are dropped and counted, so the table says how much it left out.
      const all = list(value.rows, `${at} rows`, 0, 10_000)
      const rows = all.slice(0, COMMANDO_UI_LIMITS.rows).map((row, r) => {
        const cells = list(row, `${at} row ${r + 1}`, columns.length, columns.length)
        return cells.map((entry, c) => cell(entry, `${at} row ${r + 1} cell ${c + 1}`))
      })
      return { component: 'table', ...withId, columns, rows, truncatedRows: all.length - rows.length }
    }
    case 'stats': {
      const items = list(value.items, `${at} items`, 1, COMMANDO_UI_LIMITS.stats).map((item, i) => {
        if (!isRecord(item)) fail(`${at} item ${i + 1} must be an object`)
        const tone: StatTone = item.tone === undefined ? 'neutral' : item.tone === 'good' || item.tone === 'bad' || item.tone === 'neutral' ? item.tone : fail(`${at} item ${i + 1} tone must be good, bad or neutral`)
        const delta = item.delta === undefined ? undefined : statText(item.delta, `${at} item ${i + 1} delta`, COMMANDO_UI_LIMITS.statDelta)
        return {
          label: text(item.label, `${at} item ${i + 1} label`, COMMANDO_UI_LIMITS.statLabel),
          value: statText(item.value, `${at} item ${i + 1} value`, COMMANDO_UI_LIMITS.statValue),
          ...(delta === undefined ? {} : { delta }), tone,
        }
      })
      return { component: 'stats', ...withId, items }
    }
    default:
      return fail(typeof value.component === 'string' ? `unknown component "${value.component.slice(0, 40)}"` : `${at} has no component`)
  }
}

/** True when the JSON is cut off rather than wrong, as it is mid-stream. */
function looksTruncated(source: string): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') depth--
  }
  return inString || depth > 0
}

function parseUncached(source: string): CommandoUiParse {
  const trimmed = source.trim()
  if (!trimmed) return { ok: false, reason: 'the block is empty', incomplete: true }
  if (trimmed.length > COMMANDO_UI_LIMITS.source) return { ok: false, reason: 'the block is too long', incomplete: false }
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'not valid JSON', incomplete: looksTruncated(trimmed) }
  }
  try {
    const entries = Array.isArray(json) ? json : [json]
    if (entries.length === 0 || entries.length > COMMANDO_UI_LIMITS.blocks) fail(`a fence holds 1 to ${COMMANDO_UI_LIMITS.blocks} blocks`)
    return { ok: true, blocks: entries.map(block) }
  } catch (error) {
    return { ok: false, reason: error instanceof Invalid ? error.message : 'invalid block', incomplete: false }
  }
}

const CACHE_LIMIT = 200
const cache = new Map<string, CommandoUiParse>()

/** Parses a fence's text once; a repeated render of the same text returns the same result object. Never throws. */
export function parseCommandoUi(source: string): CommandoUiParse {
  const hit = cache.get(source)
  if (hit) return hit
  const result = parseUncached(source)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(source, result)
  return result
}

type Choice = Extract<CommandoUiBlock, { component: 'choice' }>
type Approve = Extract<CommandoUiBlock, { component: 'approve' }>
export type ApproveVerdict = 'Approved' | 'Rejected'

/** What the user's pick is sent as: `Archive storage: SQLite in ~/.commando`. */
export function formatChoiceAnswer(block: Pick<Choice, 'prompt' | 'options'>, selected: readonly string[]): string {
  const ordered = block.options.filter((option) => selected.includes(option))
  return `${block.prompt}: ${ordered.join(', ')}`
}

/** `Approved: Ship the migration`, with ` — note: …` when the user wrote one. */
export function formatApproveAnswer(block: Pick<Approve, 'prompt'>, verdict: ApproveVerdict, note = ''): string {
  const trimmed = note.trim()
  return `${verdict}: ${block.prompt}${trimmed ? ` — note: ${trimmed}` : ''}`
}

/** The answer text a user message holds for this block, as the label to show, or undefined when it isn't one. */
export function matchBlockAnswer(block: CommandoUiBlock, message: string): string | undefined {
  const sent = message.trim()
  if (block.component === 'choice') {
    if (!block.multiple) return block.options.find((option) => formatChoiceAnswer(block, [option]) === sent)
    // Every subset in option order, since a label may itself hold a comma.
    for (let mask = 1; mask < 1 << block.options.length; mask++) {
      const chosen = block.options.filter((_, i) => mask & (1 << i))
      if (formatChoiceAnswer(block, chosen) === sent) return chosen.join(', ')
    }
    return undefined
  }
  if (block.component === 'approve') {
    for (const verdict of ['Approved', 'Rejected'] as const) {
      const base = formatApproveAnswer(block, verdict)
      if (sent === base) return verdict === 'Approved' ? block.approveLabel : block.rejectLabel
      if (sent.startsWith(`${base} — note: `)) return `${verdict === 'Approved' ? block.approveLabel : block.rejectLabel}${sent.slice(base.length).replace(' — note: ', ' — ')}`
    }
  }
  return undefined
}

export type UserMessageRef = { text: string; createdAt: number }

/** The answer a later user message gave this block; settled state is derived from the transcript, never stored. */
export function settledAnswer(block: CommandoUiBlock, replyCreatedAt: number, userMessages: readonly UserMessageRef[]): string | undefined {
  for (const message of userMessages) {
    if (message.createdAt < replyCreatedAt) continue
    const answer = matchBlockAnswer(block, message.text)
    if (answer !== undefined) return answer
  }
  return undefined
}
