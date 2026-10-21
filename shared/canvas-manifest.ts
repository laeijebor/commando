export const CANVAS_STATUSES = ['idea', 'in-progress', 'ready-for-review', 'ready-for-dev', 'shipped'] as const
export const CANVAS_ANNOTATION_KINDS = ['development', 'important', 'design', 'question'] as const
/** Each page has its own coordinate space. A manifest without `pages` is one page and parses with `pages: []`.
 * The parser keeps every page's frames, sections and notes in the flat lists, tagged with `page`. */
export type CanvasPage = { id: string; title: string }
export type CanvasFrame = {
  id: string; title: string; platform?: string; src: string; x: number; y: number; w: number; h: number; page?: string
  focus?: number; interactive?: boolean; interactiveNote?: string
  variant?: { title: string; context?: string; description?: string }
}
export type CanvasSection = {
  id: string; title: string; ticket?: string; status: typeof CANVAS_STATUSES[number]; frames: string[]; page?: string
}
export type CanvasAnnotation = {
  id: string; kind: typeof CANVAS_ANNOTATION_KINDS[number]; text?: string; title?: string; items?: string[]
  target?: { frame: string; label?: string }; x: number; y: number; w?: number; page?: string
  /** Stays at x/y instead of being laid out beside its target. Set when the user drags the note. */
  fixed?: boolean
  /** Question notes only: answer queue identity (defaults to id), choices, and the agent-recorded answer. */
  key?: string; options?: string[]; multiple?: boolean; answer?: string
}
export type CanvasManifest = { title: string; pages: CanvasPage[]; sections: CanvasSection[]; frames: CanvasFrame[]; annotations: CanvasAnnotation[] }
export type CanvasManifestResult = { manifest: CanvasManifest; errors: string[] }
/** A frame or note move. `fixed` applies to notes only and defaults to true. */
export type CanvasMove = { id: string; x: number; y: number; fixed?: boolean }
export type CanvasStatusChange = { id: string; status: CanvasSection['status'] }
export type CanvasWriteResult = CanvasManifestResult & { contentHash: string }

export const encodeCanvasPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

export function canvasRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /[\\\0?#%]/.test(value) || value.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null
  const parts = value.split('/')
  if (parts.includes('..')) return null
  const path = parts.filter((part) => part && part !== '.').join('/')
  return path || null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keeps usable entries while reporting malformed fields to both author and viewer. */
export function parseCanvasManifest(input: unknown): CanvasManifestResult {
  const manifest: CanvasManifest = { title: '', pages: [], sections: [], frames: [], annotations: [] }
  const errors: string[] = []
  const fail = (path: string, reason: string) => { errors.push(`${path}: ${reason}`) }
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { fail('canvas.json', 'must be valid JSON'); return { manifest, errors } }
  }
  if (!record(input)) { fail('canvas.json', 'must be an object'); return { manifest, errors } }
  const string = (obj: Record<string, unknown>, key: string, path: string, required = false): string | undefined => {
    const value = obj[key]
    if (value === undefined && !required) return undefined
    if (typeof value !== 'string' || (required && !value.trim())) { fail(`${path}${key}`, 'must be a non-empty string'); return undefined }
    return value
  }
  const number = (obj: Record<string, unknown>, key: string, path: string, fallback?: number, positive = false): number | undefined => {
    const value = obj[key]
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
      fail(`${path}${key}`, positive ? 'must be a positive number' : 'must be a finite number'); return fallback
    }
    return value
  }
  // Page ids only name pages, so they get their own namespace.
  const ids = new Set<string>(), pageIds = new Set<string>()
  const id = (obj: Record<string, unknown>, path: string, taken = ids) => {
    const value = string(obj, 'id', path, true)
    if (!value) return undefined
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) { fail(`${path}id`, 'must match ^[A-Za-z0-9_-]{1,64}$'); return undefined }
    if (taken.has(value)) { fail(`${path}id`, `duplicate id "${value}"`); return undefined }
    taken.add(value); return value
  }
  type Entry = { value: unknown; path: string; page?: string }
  const entries: Record<'frames' | 'sections' | 'annotations', Entry[]> = { frames: [], sections: [], annotations: [] }
  const list = (obj: Record<string, unknown>, key: keyof typeof entries, prefix: string, required: boolean, page?: string) => {
    const value = obj[key]
    if (value === undefined && !required) return
    if (!Array.isArray(value)) { fail(`${prefix}${key}`, 'must be an array'); return }
    value.forEach((item, index) => entries[key].push({ value: item, path: `${prefix}${key}[${index}].`, ...(page ? { page } : {}) }))
  }
  const at = (page?: string) => page ? { page } : {}
  manifest.title = string(input, 'title', '', true) ?? ''
  // An empty pages list reads as no pages, so a parsed single-page manifest round-trips.
  if (input.pages === undefined || (Array.isArray(input.pages) && !input.pages.length)) {
    list(input, 'frames', '', true); list(input, 'sections', '', false); list(input, 'annotations', '', false)
  } else if (!Array.isArray(input.pages)) fail('pages', 'must be an array of pages')
  else {
    for (const key of ['frames', 'sections', 'annotations']) if (input[key] !== undefined) fail(key, 'belongs inside a page; a canvas with pages keeps its frames, sections and notes in pages[]')
    input.pages.forEach((value, index) => {
      const path = `pages[${index}].`
      if (!record(value)) { fail(path.slice(0, -1), 'must be an object'); return }
      const pageId = id(value, path, pageIds), title = string(value, 'title', path, true)
      if (!pageId || !title) return
      manifest.pages.push({ id: pageId, title })
      list(value, 'frames', path, true, pageId); list(value, 'sections', path, false, pageId); list(value, 'annotations', path, false, pageId)
    })
  }
  entries.frames.forEach(({ value, path, page }) => {
    if (!record(value)) { fail(path.slice(0, -1), 'must be an object'); return }
    const frameId = id(value, path), title = string(value, 'title', path, true)
    const src = canvasRelativePath(value.src)
    if (!src) fail(`${path}src`, 'must be a relative path inside the canvas folder')
    const x = number(value, 'x', path), y = number(value, 'y', path)
    const w = number(value, 'w', path, 390, true)!, h = number(value, 'h', path, 844, true)!
    const platform = string(value, 'platform', path)
    let focus: number | undefined
    if (value.focus !== undefined) {
      if (!Number.isSafeInteger(value.focus) || (value.focus as number) < 1) fail(`${path}focus`, 'must be a positive integer')
      else focus = value.focus as number
    }
    let interactive: boolean | undefined
    if (value.interactive !== undefined) {
      if (typeof value.interactive !== 'boolean') fail(`${path}interactive`, 'must be a boolean')
      else interactive = value.interactive
    }
    let interactiveNote = string(value, 'interactiveNote', path)
    if (interactiveNote !== undefined && interactive !== true) { fail(`${path}interactiveNote`, 'requires interactive: true'); interactiveNote = undefined }
    let variant: CanvasFrame['variant']
    if (value.variant !== undefined) {
      if (!record(value.variant)) fail(`${path}variant`, 'must be an object')
      else {
        const title = string(value.variant, 'title', `${path}variant.`, true)
        const context = string(value.variant, 'context', `${path}variant.`)
        const description = string(value.variant, 'description', `${path}variant.`)
        if (title) variant = { title, context, description }
      }
    }
    if (frameId && title && src && x !== undefined && y !== undefined) manifest.frames.push({ id: frameId, title, src, x, y, w, h, platform, focus, interactive, interactiveNote, variant, ...at(page) })
  })
  const framePages = new Map(manifest.frames.map((frame) => [frame.id, frame.page]))
  // A section or note draws on its own page, so the frames it points at must be there too.
  const frameError = (frame: string, page?: string) => !framePages.has(frame) ? `unknown frame "${frame}"`
    : framePages.get(frame) !== page ? `frame "${frame}" is on another page` : null
  const annotationPaths = new Map<CanvasAnnotation, string>()
  entries.sections.forEach(({ value, path, page }) => {
    if (!record(value)) { fail(path.slice(0, -1), 'must be an object'); return }
    const sectionId = id(value, path), title = string(value, 'title', path, true), ticket = string(value, 'ticket', path)
    const status = CANVAS_STATUSES.find((status) => status === value.status)
    if (!status) fail(`${path}status`, `must be one of ${CANVAS_STATUSES.join(', ')}`)
    const frames: string[] = []
    if (!Array.isArray(value.frames)) fail(`${path}frames`, 'must be an array of frame ids')
    else value.frames.forEach((frame, i) => {
      const error = typeof frame === 'string' ? frameError(frame, page) : `unknown frame "${String(frame)}"`
      if (error) fail(`${path}frames[${i}]`, error)
      else frames.push(frame as string)
    })
    if (sectionId && title && status) manifest.sections.push({ id: sectionId, title, ticket, status, frames, ...at(page) })
  })
  entries.annotations.forEach(({ value, path, page }) => {
    if (!record(value)) { fail(path.slice(0, -1), 'must be an object'); return }
    const annotationId = id(value, path)
    const kind = CANVAS_ANNOTATION_KINDS.find((kind) => kind === value.kind)
    if (!kind) fail(`${path}kind`, `must be one of ${CANVAS_ANNOTATION_KINDS.join(', ')}`)
    const x = number(value, 'x', path), y = number(value, 'y', path)
    const w = value.w === undefined ? undefined : number(value, 'w', path, undefined, true)
    const title = string(value, 'title', path), text = string(value, 'text', path)
    let fixed: boolean | undefined
    if (value.fixed !== undefined) {
      if (typeof value.fixed !== 'boolean') fail(`${path}fixed`, 'must be a boolean')
      else fixed = value.fixed
    }
    let items: string[] | undefined
    if (value.items !== undefined) {
      if (!Array.isArray(value.items)) fail(`${path}items`, 'must be an array of strings')
      else items = value.items.filter((item, i): item is string => {
        if (typeof item === 'string') return true
        fail(`${path}items[${i}]`, 'must be a string'); return false
      })
    }
    let target: CanvasAnnotation['target']
    if (value.target !== undefined) {
      if (!record(value.target)) fail(`${path}target`, 'must be an object')
      else {
        const frame = string(value.target, 'frame', `${path}target.`, true)
        const label = string(value.target, 'label', `${path}target.`)
        const error = frame ? frameError(frame, page) : null
        if (frame && !error) target = { frame, label }
        else if (error) fail(`${path}target.frame`, error)
      }
    }
    const question: Pick<CanvasAnnotation, 'key' | 'options' | 'multiple' | 'answer'> = {}
    const questionKeys = ['key', 'options', 'multiple', 'answer'].filter((key) => value[key] !== undefined)
    if (kind && kind !== 'question') questionKeys.forEach((key) => fail(`${path}${key}`, 'only applies to question notes'))
    else if (kind === 'question') {
      const key = string(value, 'key', path)
      if (key !== undefined && (!key.trim() || key.length > 128)) fail(`${path}key`, 'must be 1–128 characters')
      else if (key !== undefined) question.key = key
      if (value.options !== undefined) {
        const options = Array.isArray(value.options) ? value.options : null
        if (!options || !options.length || options.length > 50) fail(`${path}options`, 'must be an array of 1–50 strings')
        else {
          const valid = options.filter((option, i): option is string => {
            if (typeof option === 'string' && option.trim() && option.length <= 256) return true
            fail(`${path}options[${i}]`, 'must be a non-empty string of at most 256 characters'); return false
          })
          if (valid.length) question.options = valid
        }
      }
      if (value.multiple !== undefined) {
        if (typeof value.multiple !== 'boolean') fail(`${path}multiple`, 'must be a boolean')
        else if (!question.options) fail(`${path}multiple`, 'needs options')
        else question.multiple = value.multiple
      }
      // Answers carry the question text, capped at 256 characters; a longer prompt could not be told apart from an edit.
      const prompt = text || title
      if (prompt !== undefined && prompt.length > 256) fail(`${path}${text ? 'text' : 'title'}`, 'question notes must be at most 256 characters; move detail into items')
      const answer = string(value, 'answer', path)
      if (answer !== undefined && (!answer.trim() || answer.length > 1024)) fail(`${path}answer`, 'must be 1–1024 characters')
      else if (answer !== undefined) question.answer = answer
    }
    if (annotationId && kind && x !== undefined && y !== undefined) {
      const note: CanvasAnnotation = { id: annotationId, kind, x, y, w, fixed, title, text, items, target, ...question, ...at(page) }
      manifest.annotations.push(note); annotationPaths.set(note, path)
    }
  })
  // Answers queue by key (default id), so two questions sharing one would overwrite each other's answer.
  // Ids are unique, so dropping a key that repeats another question's id or an earlier key keeps all unique.
  const questions = manifest.annotations.filter((note) => note.kind === 'question'), keys = new Set<string>()
  for (const note of questions) {
    if (note.key === undefined) continue
    if (keys.has(note.key) || questions.some((other) => other !== note && other.id === note.key)) {
      fail(`${annotationPaths.get(note)}key`, `duplicate question key "${note.key}"`)
      delete note.key
    } else keys.add(note.key)
  }
  return { manifest, errors }
}
