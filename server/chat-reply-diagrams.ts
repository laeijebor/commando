import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { ChatItem, ChatReplyDiagram, ChatReplyDiagramError } from '../shared/agent-chat.js'
import { MAX_PR_DIAGRAM_SOURCE_BYTES, prDiagramHash } from '../shared/pr-diagram.js'
import type { ChatImageStore } from './chat-images.js'

/**
 * An agent can write a pr-diagram document straight into its reply as a
 * ```pr-diagram fence. The daemon renders each one with the user's pr-diagram
 * renderer (it lives outside this repo, with the skill), stores the SVG with
 * the chat images and attaches it under the hash of the fence's source, so
 * the renderer can find it again (shared/pr-diagram.ts).
 *
 * The reply text never reaches a shell: the document is written to a randomly
 * named file in a private temporary folder and the renderer runs with execFile.
 */

export const PR_DIAGRAM_TIMEOUT_MS = 15_000
const MAX_DIAGRAMS_PER_REPLY = 10
/** Renders at once, across all chats. */
const MAX_CONCURRENT_RENDERS = 2
const MAX_REMEMBERED = 500
/** A timeout or crash may be the machine being busy: try that document again after a while. */
const RETRY_AFTER_MS = 60_000
const LOCATE_TTL_MS = 30_000

export type PrDiagramExecutor = (file: string, args: readonly string[], options: { timeout: number; cwd: string }) => Promise<{ stdout: string; stderr: string }>

/** Runs a file without a shell; rejects with the exit code, signal and output on failure. */
export const execFileExecutor: PrDiagramExecutor = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, {
    timeout: options.timeout, cwd: options.cwd, maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }))
    else resolve({ stdout: String(stdout), stderr: String(stderr) })
  })
})

/** Where the renderer is: `COMMANDO_PR_DIAGRAM_BIN`, then the skill in ~/.claude, then ~/.claudep. */
export function prDiagramRendererCandidates(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  return [
    ...(env.COMMANDO_PR_DIAGRAM_BIN ? [env.COMMANDO_PR_DIAGRAM_BIN] : []),
    join(home, '.claude', 'skills', 'pr-diagram', 'bin', 'pr-diagram.mjs'),
    join(home, '.claudep', 'skills', 'pr-diagram', 'bin', 'pr-diagram.mjs'),
  ]
}

export async function locatePrDiagramRenderer(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Not there: try the next place.
    }
  }
  return null
}

const parser = unified().use(remarkParse).use(remarkGfm)
type Node = { type: string; lang?: string | null; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const CLOSING_FENCE = /\n[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/

/** The sources of the closed ```pr-diagram fences in a reply, in order, each once. A fence still streaming is skipped. */
export function prDiagramFences(text: string): string[] {
  if (!text.includes('pr-diagram')) return []
  const sources: string[] = []
  const visit = (node: Node) => {
    if (node.type === 'code') {
      const raw = text.slice(node.position?.start.offset, node.position?.end.offset)
      if (node.lang === 'pr-diagram' && node.value?.trim() && CLOSING_FENCE.test(raw.trimEnd())) sources.push(node.value)
      return
    }
    node.children?.forEach(visit)
  }
  visit(parser.parse(text) as Node)
  return [...new Set(sources)]
}

type Result = { id: string } | { error: ChatReplyDiagramError; message?: string }
type Remembered = { result: Result; until?: number }

/** What the renderer reported, without the temporary file's name or its summary line. */
function rendererMessage(stderr: string, file: string): string {
  return stderr.split('\n')
    .map((line) => line.split(file).join('document').replace(/^pr-diagram:\s*/, '').replace(/^document:\s*(?:error:\s*)?/, '').trim())
    .filter((line) => line && !/^\d+ of \d+ documents? failed$/.test(line))
    .join('\n')
    .slice(0, 2000)
}

export class ChatReplyDiagrams {
  private readonly remembered = new Map<string, Remembered>()
  private readonly rendering = new Map<string, Promise<Result>>()
  private readonly parsed = new Map<string, { text: string; sources: string[] }>()
  private readonly waiting: (() => void)[] = []
  private running = 0
  private located?: { bin: string | null; at: number }
  private loggedFailure = false

  constructor(
    private readonly store: Pick<ChatImageStore, 'saveReplyImage'>,
    private readonly options: {
      execute?: PrDiagramExecutor
      candidates?: () => readonly string[]
      log?: (message: string) => void
      tempRoot?: string
      now?: () => number
      timeoutMs?: number
    } = {},
  ) {}

  /**
   * The items with each reply's rendered diagrams attached. A finished reply
   * waits for its renders; a streaming one doesn't, and picks the result up
   * with a later update, so a slow render never holds up the stream.
   */
  attach(items: readonly ChatItem[]): Promise<ChatItem[]> {
    return Promise.all(items.map((item) => item.kind === 'assistant_message' ? this.attachTo(item) : item))
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private sources(item: Extract<ChatItem, { kind: 'assistant_message' }>): string[] {
    const known = this.parsed.get(item.id)
    if (known?.text === item.text) return known.sources
    const sources = prDiagramFences(item.text).slice(0, MAX_DIAGRAMS_PER_REPLY)
    this.parsed.delete(item.id)
    this.parsed.set(item.id, { text: item.text, sources })
    if (this.parsed.size > 2000) this.parsed.delete(this.parsed.keys().next().value!)
    return sources
  }

  private async attachTo(item: Extract<ChatItem, { kind: 'assistant_message' }>): Promise<ChatItem> {
    const { diagrams: _previous, ...rest } = item
    const streaming = item.status === 'running'
    const diagrams: ChatReplyDiagram[] = []
    for (const source of this.sources(item)) {
      const hash = prDiagramHash(source)
      let result = this.cached(hash)
      if (!result) {
        const task = this.start(hash, source)
        if (!streaming) result = await task
      }
      if (result) diagrams.push({ hash, ...result })
    }
    return diagrams.length ? { ...rest, diagrams } : rest
  }

  private cached(hash: string): Result | undefined {
    const known = this.remembered.get(hash)
    if (!known) return undefined
    if (known.until !== undefined && known.until <= this.now()) {
      this.remembered.delete(hash)
      return undefined
    }
    return known.result
  }

  /** Renders a document once, however many updates ask for it meanwhile. */
  private start(hash: string, source: string): Promise<Result> {
    const pending = this.rendering.get(hash)
    if (pending) return pending
    const task = this.render(source).then((result) => {
      this.rendering.delete(hash)
      // A missing renderer isn't remembered, so installing it works without a restart.
      if (!('error' in result && result.error === 'renderer_missing')) {
        const transient = 'error' in result && (result.error === 'timeout' || result.error === 'failed')
        this.remembered.delete(hash)
        this.remembered.set(hash, { result, ...(transient ? { until: this.now() + RETRY_AFTER_MS } : {}) })
        if (this.remembered.size > MAX_REMEMBERED) this.remembered.delete(this.remembered.keys().next().value!)
      }
      return result
    })
    this.rendering.set(hash, task)
    return task
  }

  private async renderer(): Promise<string | null> {
    if (this.located && this.now() - this.located.at < LOCATE_TTL_MS) return this.located.bin
    const bin = await locatePrDiagramRenderer((this.options.candidates ?? prDiagramRendererCandidates)())
    this.located = { bin, at: this.now() }
    return bin
  }

  private async slot(): Promise<() => void> {
    if (this.running >= MAX_CONCURRENT_RENDERS) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    return () => {
      this.running--
      this.waiting.shift()?.()
    }
  }

  /** Never rejects: every failure is a result the reply shows. */
  private async render(source: string): Promise<Result> {
    if (Buffer.byteLength(source) > MAX_PR_DIAGRAM_SOURCE_BYTES) return { error: 'too_large' }
    try {
      const document = JSON.parse(source) as unknown
      if (!document || typeof document !== 'object' || Array.isArray(document)) return { error: 'invalid', message: 'A pr-diagram document is one JSON object with a "type".' }
    } catch (error) {
      return { error: 'invalid', message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    const bin = await this.renderer()
    if (!bin) return { error: 'renderer_missing' }
    const release = await this.slot()
    let folder: string | undefined
    try {
      folder = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'commando-pr-diagram-'))
      await chmod(folder, 0o700)
      const name = randomBytes(12).toString('hex')
      const file = join(folder, `${name}.json`)
      await writeFile(file, source, { mode: 0o600, flag: 'wx' })
      try {
        await (this.options.execute ?? execFileExecutor)(process.execPath, [bin, 'render', file, '--out', folder], {
          timeout: this.options.timeoutMs ?? PR_DIAGRAM_TIMEOUT_MS, cwd: folder,
        })
      } catch (error) {
        const failure = error as { killed?: boolean; signal?: string | null; code?: unknown; stderr?: string }
        if (failure.killed || failure.signal) return { error: 'timeout' }
        const message = rendererMessage(failure.stderr ?? '', file)
        if (typeof failure.code === 'number' && message) return { error: 'invalid', message }
        return { error: 'failed', ...(message ? { message } : {}) }
      }
      const saved = await this.store.saveReplyImage(await readFile(join(folder, `${name}.svg`)))
      if ('error' in saved || !saved.id.endsWith('.svg')) return { error: 'failed', message: "The renderer didn't write an SVG." }
      return { id: saved.id }
    } catch (error) {
      if (!this.loggedFailure) {
        this.loggedFailure = true
        this.options.log?.(`Couldn't render a pr-diagram: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { error: 'failed' }
    } finally {
      release()
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {})
    }
  }
}
