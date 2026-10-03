import type { SimComponent, SimElement } from '../shared/sim-inspector.js'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined }

export function inspectorJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { /* Some CLIs prefix their JSON with diagnostic lines. */ }
  for (const line of raw.split('\n')) {
    try { return JSON.parse(line) } catch { /* Keep looking for a JSON line. */ }
  }
  throw new Error('Invalid JSON response from baguette describe-ui')
}

export function parseSimElement(raw: string): SimElement | null {
  const value = inspectorJson(raw)
  if (value === null) return null
  const node = object(value), frame = object(node.frame)
  if (typeof node.role !== 'string' || !['x', 'y', 'width', 'height'].every((key) => typeof frame[key] === 'number' && Number.isFinite(frame[key]))
    || (frame.width as number) < 0 || (frame.height as number) < 0) throw new Error('Invalid element response from baguette describe-ui')
  return { role: node.role, label: text(node.label) ?? null, identifier: text(node.identifier) ?? null,
    title: text(node.title) ?? null, value: typeof node.value === 'string' || typeof node.value === 'boolean'
      || (typeof node.value === 'number' && Number.isFinite(node.value)) ? node.value : null,
    frame: { x: frame.x as number, y: frame.y as number, width: frame.width as number, height: frame.height as number } }
}

export function parseSimComponents(raw: string): { components: SimComponent[]; raw?: string } {
  let value: unknown
  try { value = inspectorJson(raw) } catch { return { components: [], raw } }
  const components: SimComponent[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    const item = object(value), source = object(item.source ?? item.location ?? item._debugSource)
    if (item.type === 'text' && typeof item.text === 'string') {
      try { visit(JSON.parse(item.text)) } catch { /* Preserve unrecognised tool text in the raw fallback. */ }
    }
    const name = text(item.name ?? item.componentName ?? item.displayName ?? item.component)
    const file = text(item.file ?? item.fileName ?? item.filePath ?? item.sourceFile ?? source.file ?? source.fileName ?? source.filePath)
    const line = integer(item.line ?? item.lineNumber ?? source.line ?? source.lineNumber)
    if (name && (file || line !== undefined)) {
      components.push({ name, ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}),
        ...(integer(item.column ?? item.columnNumber ?? source.column ?? source.columnNumber) !== undefined
          ? { column: integer(item.column ?? item.columnNumber ?? source.column ?? source.columnNumber) } : {}),
        ...(text(item.code ?? item.codeFragment ?? item.snippet ?? source.code) ? { code: text(item.code ?? item.codeFragment ?? item.snippet ?? source.code) } : {}) })
    }
    Object.values(item).forEach((child) => { if (child && typeof child === 'object') visit(child) })
  }
  visit(value)
  return { components, ...(!components.length ? { raw } : {}) }
}
