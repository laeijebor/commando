import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { isChatReplyImageId, type ChatItem, type ChatReplyDiagram, type ChatReplyDiagramError } from '../shared/agent-chat.js'
import { MAX_PR_DIAGRAM_SOURCE_BYTES, prDiagramHash } from '../shared/pr-diagram.js'
import { MAX_SVG_BYTES, type ChatImageStore } from './chat-images.js'

/**
 * An agent can write a pr-diagram document straight into its reply as a
 * ```pr-diagram fence. The daemon renders each one with the user's pr-diagram
 * renderer (it lives outside this repo, with the skill), stores the SVG with
 * the chat images and attaches it under the hash of the fence's source, so
 * the renderer can find it again (shared/pr-diagram.ts).
 *
 * Attaching never waits for a render: a reply gets what is already rendered,
 * the render runs in the background, and `onRendered` says which replies to
 * attach again. Results that don't change (an SVG, a validation error, an
 * oversized diagram) are kept in an index beside the chat images, so a
 * restarted daemon finds earlier renders without running the renderer.
 *
 * The reply text never reaches a shell: the document is written to a randomly
 * named file in a private temporary folder and the renderer runs with execFile.
 */

export const PR_DIAGRAM_TIMEOUT_MS = 15_000
const MAX_DIAGRAMS_PER_REPLY = 10
/** Renders at once, across all chats. */
const MAX_CONCURRENT_RENDERS = 2
const MAX_REMEMBERED = 2000
/** A timeout or crash may be the machine being busy: try that document again after a while. */
const RETRY_AFTER_MS = 60_000
const LOCATE_TTL_MS = 30_000
const INDEX_FILE = 'pr-diagram-index.json'
const SAVE_DELAY_MS = 1000

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

/** Names the renderer's code as it is now: its path and the size and time of its files, so an update renders again. */
export async function prDiagramRendererVersion(bin: string): Promise<string> {
  const parts = [bin]
  const add = async (path: string) => {
    try {
      const stats = await stat(path)
      parts.push(`${path}:${stats.size}:${stats.mtimeMs}`)
    } catch {
      // Gone between listing and reading: leave it out.
    }
  }
  await add(bin)
  const lib = join(dirname(bin), '..', 'lib')
  for (const folder of [lib, join(lib, 'types')]) {
    let names: string[] = []
    try { names = await readdir(folder) } catch { continue }
    for (const name of names.sort()) if (name.endsWith('.mjs')) await add(join(folder, name))
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

const parser = unified().use(remarkParse).use(remarkGfm)
type Node = { type: string; lang?: string | null; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const CLOSING_FENCE = /\n[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/
const OPENING_FENCE = /(?:`{3,}|~{3,})[ \t]*pr-diagram/

/** The sources of the closed ```pr-diagram fences in a reply, in order, each once. A fence still streaming is skipped. */
export function prDiagramFences(text: string): string[] {
  if (!OPENING_FENCE.test(text)) return []
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
/** `until`: a result that may change is tried again after it. `unverified`: an SVG from the index whose file hasn't been checked yet. */
type Remembered = { result: Result; until?: number; unverified?: true }

/** A fence ready to render: the document to write, or why it can't be rendered at all. */
type Prepared = { hash: string; relative: boolean; document: string } | { hash: string; result: Result }

/** Screen-flow screenshots are read relative to the document, which is written to a temporary folder: anchor them to the chat's folder. */
function anchorAssets(document: Record<string, unknown>, cwd: string, home: string): boolean {
  let relative = false
  if (!Array.isArray(document.screens)) return false
  for (const screen of document.screens) {
    if (!screen || typeof screen !== 'object' || typeof (screen as { image?: unknown }).image !== 'string') continue
    const entry = screen as { image: string }
    if (isAbsolute(entry.image)) continue
    relative = true
    entry.image = entry.image.startsWith('~/') ? join(home, entry.image.slice(2)) : resolve(cwd, entry.image)
  }
  return relative
}

export function preparePrDiagram(source: string, cwd: string, home = homedir()): Prepared {
  const hash = prDiagramHash(source)
  if (Buffer.byteLength(source) > MAX_PR_DIAGRAM_SOURCE_BYTES) return { hash, result: { error: 'too_large', message: 'The document is larger than 64 KB.' } }
  let document: unknown
  try {
    document = JSON.parse(source)
  } catch (error) {
    return { hash, result: { error: 'invalid', message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` } }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { hash, result: { error: 'invalid', message: 'A pr-diagram document is one JSON object with a "type".' } }
  }
  const relative = cwd ? anchorAssets(document as Record<string, unknown>, cwd, home) : false
  return { hash, relative, document: relative ? JSON.stringify(document) : source }
}

/** What the renderer reported, without the temporary file's name or its summary line. */
function rendererMessage(stderr: string, file: string): string {
  return stderr.split('\n')
    .map((line) => line.split(file).join('document').replace(/^pr-diagram:\s*/, '').replace(/^document:\s*(?:error:\s*)?/, '').trim())
    .filter((line) => line && !/^\d+ of \d+ documents? failed$/.test(line))
    .join('\n')
    .slice(0, 2000)
}

/** Whether a result is the same every time, so it can be kept across restarts. */
const lasting = (result: Result) => !('error' in result) || result.error === 'invalid' || result.error === 'too_large'

export class ChatReplyDiagrams {
  private readonly remembered = new Map<string, Remembered>()
  private readonly rendering = new Map<string, Promise<Result>>()
  private readonly parsed = new Map<string, { text: string; cwd: string; prepared: Prepared[] }>()
  private readonly waiting: (() => void)[] = []
  private running = 0
  private located?: { bin: string | null; version: string; at: number }
  private loading?: Promise<void>
  private saveTimer?: ReturnType<typeof setTimeout>
  private loggedFailure = false

  constructor(
    private readonly store: Pick<ChatImageStore, 'saveReplyImage' | 'servedPath' | 'dir'>,
    private readonly options: {
      execute?: PrDiagramExecutor
      candidates?: () => readonly string[]
      log?: (message: string) => void
      tempRoot?: string
      now?: () => number
      timeoutMs?: number
      home?: string
      /** Where the index of lasting results is kept; beside the chat images by default. */
      indexPath?: string
    } = {},
  ) {}

  /**
   * The items with each reply's rendered diagrams attached. Never waits for a
   * render: one that isn't done yet runs in the background, and `onRendered`
   * names the replies to attach again once it is.
   */
  async attach(items: readonly ChatItem[], cwd: string, onRendered?: (itemIds: string[]) => void): Promise<ChatItem[]> {
    if (!items.some((item) => item.kind === 'assistant_message' && OPENING_FENCE.test(item.text))) {
      return items.map((item) => item.kind === 'assistant_message' && item.diagrams ? this.without(item) : item)
    }
    await this.load()
    const renderer = await this.renderer()
    return Promise.all(items.map((item) => item.kind === 'assistant_message' ? this.attachTo(item, cwd, renderer, onRendered) : item))
  }

  /** Writes the index now rather than after the usual delay. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    await this.save()
  }

  private without(item: Extract<ChatItem, { kind: 'assistant_message' }>): Extract<ChatItem, { kind: 'assistant_message' }> {
    const { diagrams: _previous, ...rest } = item
    return rest
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private get indexPath(): string {
    return this.options.indexPath ?? join(this.store.dir, INDEX_FILE)
  }

  private prepared(item: Extract<ChatItem, { kind: 'assistant_message' }>, cwd: string): Prepared[] {
    const known = this.parsed.get(item.id)
    if (known?.text === item.text && known.cwd === cwd) return known.prepared
    const prepared = prDiagramFences(item.text).slice(0, MAX_DIAGRAMS_PER_REPLY).map((source) => preparePrDiagram(source, cwd, this.options.home))
    this.parsed.delete(item.id)
    this.parsed.set(item.id, { text: item.text, cwd, prepared })
    if (this.parsed.size > 500) this.parsed.delete(this.parsed.keys().next().value!)
    return prepared
  }

  private async attachTo(
    item: Extract<ChatItem, { kind: 'assistant_message' }>, cwd: string,
    renderer: { bin: string | null; version: string }, onRendered?: (itemIds: string[]) => void,
  ): Promise<ChatItem> {
    const rest = this.without(item)
    const diagrams: ChatReplyDiagram[] = []
    for (const fence of this.prepared(item, cwd)) {
      if ('result' in fence) {
        diagrams.push({ hash: fence.hash, ...fence.result })
        continue
      }
      if (!renderer.bin) {
        diagrams.push({ hash: fence.hash, error: 'renderer_missing' })
        continue
      }
      const key = createHash('sha256').update(`${renderer.version}\0${fence.relative ? cwd : ''}\0${fence.hash}`).digest('hex')
      const known = await this.cached(key)
      if (known) {
        diagrams.push({ hash: fence.hash, ...known })
        continue
      }
      const task = this.start(key, renderer.bin, fence.document)
      if (onRendered) void task.then(() => onRendered([item.id]))
    }
    return diagrams.length ? { ...rest, diagrams } : rest
  }

  private async cached(key: string): Promise<Result | undefined> {
    const known = this.remembered.get(key)
    if (!known) return undefined
    if (known.until !== undefined && known.until <= this.now()) {
      this.remembered.delete(key)
      return undefined
    }
    if (known.unverified && 'id' in known.result) {
      // An SVG from an earlier run: the prune may have removed it since. Marking it used keeps it.
      const path = this.store.servedPath(known.result.id)
      const time = new Date()
      if (!path || !await utimes(path, time, time).then(() => true, () => false)) {
        this.remembered.delete(key)
        this.scheduleSave()
        return undefined
      }
      delete known.unverified
    }
    return known.result
  }

  private remember(key: string, result: Result): void {
    this.remembered.delete(key)
    this.remembered.set(key, { result, ...(lasting(result) ? {} : { until: this.now() + RETRY_AFTER_MS }) })
    if (this.remembered.size > MAX_REMEMBERED) this.remembered.delete(this.remembered.keys().next().value!)
    if (lasting(result)) this.scheduleSave()
  }

  /** Renders a document once, however many updates ask for it meanwhile. */
  private start(key: string, bin: string, document: string): Promise<Result> {
    const pending = this.rendering.get(key)
    if (pending) return pending
    const task = this.render(bin, document).then((result) => {
      this.remember(key, result)
      this.rendering.delete(key)
      return result
    })
    this.rendering.set(key, task)
    return task
  }

  private async renderer(): Promise<{ bin: string | null; version: string }> {
    if (this.located && this.now() - this.located.at < LOCATE_TTL_MS) return this.located
    const bin = await locatePrDiagramRenderer((this.options.candidates ?? prDiagramRendererCandidates)())
    this.located = { bin, version: bin ? await prDiagramRendererVersion(bin) : '', at: this.now() }
    return this.located
  }

  private async slot(): Promise<() => void> {
    if (this.running >= MAX_CONCURRENT_RENDERS) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    return () => {
      this.running--
      this.waiting.shift()?.()
    }
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      let entries: unknown
      try {
        entries = (JSON.parse(await readFile(this.indexPath, 'utf8')) as { entries?: unknown }).entries
      } catch {
        return
      }
      if (!Array.isArray(entries)) return
      for (const entry of entries.slice(-MAX_REMEMBERED)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !/^[0-9a-f]{64}$/.test(entry[0]) || this.remembered.has(entry[0])) continue
        const value = entry[1] as Record<string, unknown> | null
        if (value && isChatReplyImageId(value.id) && String(value.id).endsWith('.svg')) {
          this.remembered.set(entry[0], { result: { id: value.id as string }, unverified: true })
        } else if (value && (value.error === 'invalid' || value.error === 'too_large')) {
          const message = typeof value.message === 'string' ? value.message.slice(0, 2000) : undefined
          this.remembered.set(entry[0], { result: { error: value.error, ...(message ? { message } : {}) } })
        }
      }
    })()
    return this.loading
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  private async save(): Promise<void> {
    const entries = [...this.remembered].filter(([, known]) => known.until === undefined).map(([key, known]) => [key, known.result])
    const path = this.indexPath
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      this.logOnce(`Couldn't save the pr-diagram index: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private logOnce(message: string): void {
    if (this.loggedFailure) return
    this.loggedFailure = true
    this.options.log?.(message)
  }

  /** Never rejects: every failure is a result the reply shows. */
  private async render(bin: string, document: string): Promise<Result> {
    const release = await this.slot()
    let folder: string | undefined
    try {
      folder = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'commando-pr-diagram-'))
      await chmod(folder, 0o700)
      const name = randomBytes(12).toString('hex')
      const file = join(folder, `${name}.json`)
      await writeFile(file, document, { mode: 0o600, flag: 'wx' })
      try {
        await (this.options.execute ?? execFileExecutor)(process.execPath, [bin, 'render', file, '--out', folder], {
          timeout: this.options.timeoutMs ?? PR_DIAGRAM_TIMEOUT_MS, cwd: folder,
        })
      } catch (error) {
        const failure = error as { killed?: boolean; signal?: string | null; code?: unknown; stderr?: string }
        if (failure.killed || failure.signal) return { error: 'timeout' }
        const stderr = failure.stderr ?? ''
        const message = rendererMessage(stderr, file)
        // `<file>: error: …` lines are the renderer's validation; anything else is a crash, tried again later.
        if (typeof failure.code === 'number' && stderr.includes(`${file}: error:`)) return { error: 'invalid', message }
        return { error: 'failed', ...(message ? { message } : {}) }
      }
      const output = join(folder, `${name}.svg`)
      if ((await stat(output)).size > MAX_SVG_BYTES) return { error: 'too_large', message: 'The diagram is larger than 5 MB.' }
      const saved = await this.store.saveReplyImage(await readFile(output))
      if ('error' in saved && saved.error === 'too_large') return { error: 'too_large', message: 'The diagram is larger than 5 MB.' }
      if ('error' in saved || !saved.id.endsWith('.svg')) return { error: 'failed', message: "The renderer didn't write an SVG." }
      return { id: saved.id }
    } catch (error) {
      this.logOnce(`Couldn't render a pr-diagram: ${error instanceof Error ? error.message : String(error)}`)
      return { error: 'failed' }
    } finally {
      release()
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {})
    }
  }
}
