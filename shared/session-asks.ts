import type { SessionAsk } from './protocol.js'

export const MAX_ASKS = 10
export const MAX_ASK_OPTIONS = 6
export const ASK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const LIMITS = { question: 240, context: 360, why: 600, option: 80, link: 2_048 } as const
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maximum && !CONTROL.test(trimmed) ? trimmed : null
}

function optionalText(value: unknown, maximum: number): string | undefined | null {
  return value === undefined ? undefined : text(value, maximum)
}

function link(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  const candidate = text(value, LIMITS.link)
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** The ask an agent raised (no `askedAt`) or a stored one; null when any field is invalid. */
export function parseSessionAsk(value: unknown, askedAt?: number): SessionAsk | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const key = typeof record.key === 'string' && ASK_KEY.test(record.key) ? record.key : null
  const question = text(record.question, LIMITS.question)
  const context = optionalText(record.context, LIMITS.context)
  const why = optionalText(record.why, LIMITS.why)
  const url = link(record.link)
  const optionValues = record.options === undefined ? [] : record.options
  if (!Array.isArray(optionValues) || optionValues.length > MAX_ASK_OPTIONS) return null
  const options = optionValues.map((option) => text(option, LIMITS.option))
  const at = askedAt ?? record.askedAt
  const recommend = record.recommend
  if (!key || !question || context === null || why === null || url === null || options.includes(null)
    || new Set(options).size !== options.length
    || (recommend !== undefined && (!Number.isSafeInteger(recommend) || (recommend as number) < 0 || (recommend as number) >= options.length))
    || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return null
  return {
    key, question,
    ...(context ? { context } : {}),
    ...(why ? { why } : {}),
    options: options as string[],
    ...(recommend !== undefined ? { recommend: recommend as number } : {}),
    ...(url ? { link: url } : {}),
    askedAt: at,
  }
}

/** The message an answer sends, so it reads on its own in the agent's conversation. */
export function askAnswerText(ask: Pick<SessionAsk, 'question'>, answer: string): string {
  return `Re: ${ask.question} → ${answer}`
}
