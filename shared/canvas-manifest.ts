export const CANVAS_STATUSES = ['idea', 'in-progress', 'ready-for-review', 'ready-for-dev', 'shipped'] as const
export const CANVAS_ANNOTATION_KINDS = ['development', 'important', 'design', 'question'] as const
export type CanvasFrame = {
  id: string; title: string; platform?: string; src: string; x: number; y: number; w: number; h: number
  focus?: number; interactive?: boolean
  variant?: { title: string; context?: string; description?: string }
}
export type CanvasSection = {
  id: string; title: string; ticket?: string; status: typeof CANVAS_STATUSES[number]; frames: string[]
}
export type CanvasAnnotation = {
  id: string; kind: typeof CANVAS_ANNOTATION_KINDS[number]; text?: string; title?: string; items?: string[]
  target?: { frame: string; label?: string }; x: number; y: number; w?: number
}
export type CanvasManifest = { title: string; sections: CanvasSection[]; frames: CanvasFrame[]; annotations: CanvasAnnotation[] }
export type CanvasManifestResult = { manifest: CanvasManifest; errors: string[] }
export type CanvasMove = { id: string; x: number; y: number }
export type CanvasStatusChange = { id: string; status: CanvasSection['status'] }
export type CanvasWriteResult = CanvasManifestResult & { contentHash: string }

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
  const manifest: CanvasManifest = { title: '', sections: [], frames: [], annotations: [] }
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
  const ids = new Set<string>()
  const id = (obj: Record<string, unknown>, path: string) => {
    const value = string(obj, 'id', path, true)
    if (!value) return undefined
    if (ids.has(value)) { fail(`${path}id`, `duplicate id "${value}"`); return undefined }
    ids.add(value); return value
  }
  const array = (key: string, required = false): unknown[] => {
    const value = input[key]
    if (value === undefined && !required) return []
    if (!Array.isArray(value)) { fail(key, 'must be an array'); return [] }
    return value
  }
  manifest.title = string(input, 'title', '', true) ?? ''
  array('frames', true).forEach((value, index) => {
    const path = `frames[${index}].`
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
    if (frameId && title && src && x !== undefined && y !== undefined) manifest.frames.push({ id: frameId, title, src, x, y, w, h, platform, focus, interactive, variant })
  })
  const frameIds = new Set(manifest.frames.map((frame) => frame.id))
  array('sections').forEach((value, index) => {
    const path = `sections[${index}].`
    if (!record(value)) { fail(path.slice(0, -1), 'must be an object'); return }
    const sectionId = id(value, path), title = string(value, 'title', path, true), ticket = string(value, 'ticket', path)
    const status = CANVAS_STATUSES.find((status) => status === value.status)
    if (!status) fail(`${path}status`, `must be one of ${CANVAS_STATUSES.join(', ')}`)
    const frames: string[] = []
    if (!Array.isArray(value.frames)) fail(`${path}frames`, 'must be an array of frame ids')
    else value.frames.forEach((frame, i) => {
      if (typeof frame !== 'string' || !frameIds.has(frame)) fail(`${path}frames[${i}]`, `unknown frame "${String(frame)}"`)
      else frames.push(frame)
    })
    if (sectionId && title && status) manifest.sections.push({ id: sectionId, title, ticket, status, frames })
  })
  array('annotations').forEach((value, index) => {
    const path = `annotations[${index}].`
    if (!record(value)) { fail(path.slice(0, -1), 'must be an object'); return }
    const annotationId = id(value, path)
    const kind = CANVAS_ANNOTATION_KINDS.find((kind) => kind === value.kind)
    if (!kind) fail(`${path}kind`, `must be one of ${CANVAS_ANNOTATION_KINDS.join(', ')}`)
    const x = number(value, 'x', path), y = number(value, 'y', path)
    const w = value.w === undefined ? undefined : number(value, 'w', path, undefined, true)
    const title = string(value, 'title', path), text = string(value, 'text', path)
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
        if (frame && frameIds.has(frame)) target = { frame, label }
        else if (frame) fail(`${path}target.frame`, `unknown frame "${frame}"`)
      }
    }
    if (annotationId && kind && x !== undefined && y !== undefined) manifest.annotations.push({ id: annotationId, kind, x, y, w, title, text, items, target })
  })
  return { manifest, errors }
}
