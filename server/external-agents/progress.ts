import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'

export interface AgentProgress {
  label?: string
  model?: string
  effort?: string
  toolUses?: number
  lastAction?: string
  lastEventAt?: number
  completed?: boolean
  durationMs?: number
  summary?: string
}

export interface ProgressSource {
  path: string
  poll: () => Promise<AgentProgress>
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value.map((block) => {
    const item = record(block)
    return typeof item.text === 'string' ? item.text : ''
  }).filter(Boolean).join('\n') : ''
}

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim()
/** macOS ps prints control characters in argv as octal escapes (a newline is `\012`). */
const normalizeCommand = (value: string) => normalizeText(value.replace(/\\0[0-7]{2}/g, ' '))

/**
 * Whether a transcript's first user message is this run's prompt. The message starts with the parsed
 * prompt when stdin was appended to it. ps drops quotes and argv boundaries, so the parsed prompt can
 * also pick up neighbouring option values; then the whole message must appear as words in the command line.
 */
export function promptMatches(text: string | undefined, prompt: string, command: string): boolean {
  const message = normalizeText(text ?? '')
  if (!message) return false
  const head = message.slice(0, 200)
  const expected = normalizeText(prompt).slice(0, 200)
  if (expected && head.startsWith(expected) && (head.length === expected.length || head[expected.length] === ' ')) return true
  return message.length >= 12 && ` ${normalizeCommand(command)} `.includes(` ${message} `)
}

export async function firstUserMessage(path: string, userText: (value: unknown) => string, notBefore = -Infinity): Promise<string | undefined> {
  const input = createReadStream(path)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const raw of lines) {
      let value: unknown
      try { value = JSON.parse(raw) as unknown } catch { continue }
      if (Number.isFinite(notBefore) && !(Date.parse(String(record(value).timestamp)) >= notBefore)) continue
      const text = userText(value)
      if (text.trim()) return text
    }
  } finally { lines.close(); input.destroy() }
  return undefined
}

/** Byte offsets and a buffered unfinished line also preserve split UTF-8 characters. */
export class JsonlTail {
  offset = 0
  private partial = Buffer.alloc(0)

  constructor(private readonly path: string, private readonly onLine: (line: unknown) => void) {}

  async poll(): Promise<void> {
    const file = await open(this.path, 'r')
    try {
      const size = (await file.stat()).size
      if (size < this.offset) { this.offset = 0; this.partial = Buffer.alloc(0) }
      while (this.offset < size) {
        const buffer = Buffer.alloc(Math.min(size - this.offset, 1024 * 1024))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset)
        if (!bytesRead) break
        this.offset += bytesRead
        const data = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)])
        let start = 0
        for (let index = 0; index < data.length; index += 1) {
          if (data[index] !== 10) continue
          try { this.onLine(JSON.parse(data.subarray(start, index).toString('utf8')) as unknown) } catch { /* Malformed lines don't prevent subsequent progress. */ }
          start = index + 1
        }
        this.partial = data.subarray(start)
      }
    } finally { await file.close() }
  }
}

export async function firstJsonLine(path: string): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < 4 * 1024 * 1024) {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      const end = buffer.subarray(0, bytesRead).indexOf(10)
      chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end))
      offset += bytesRead
      if (end >= 0) return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    }
  } finally { await file.close() }
  return undefined
}
