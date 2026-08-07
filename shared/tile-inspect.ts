/// <reference lib="dom" />
// This file is typechecked both as server code (tsconfig.node.json, no DOM
// lib) and as client code (tsconfig.app.json, DOM lib included) because it
// is a shared, isomorphic module. The probe function below runs in the
// browser page, so it needs DOM types even under the server config.

export type TileInspectGrade = 'hover' | 'click'
export type TileInspectRect = { x: number; y: number; width: number; height: number }
export type TileInspectSuccess = {
  ok: true
  selector: string
  tag: string
  rect: TileInspectRect
  text?: string
  snippet?: string
}
export type TileInspectFailure = { ok: false; error: string }
export type TileInspectResult = TileInspectSuccess | TileInspectFailure

export const MAX_INSPECT_SELECTOR = 1_024
export const MAX_INSPECT_TAG = 32
export const MAX_INSPECT_TEXT = 512
export const MAX_INSPECT_SNIPPET = 2_048

/**
 * The page-side probe. It is STRINGIFIED into a CDP Runtime.evaluate
 * expression, so it MUST stay self-contained: browser globals only, no
 * captured module constants or imports — the length caps are inlined
 * (mirrored by the exported MAX_INSPECT_* constants for the server side).
 */
export function inspectPageAt(
  doc: Document,
  x: number,
  y: number,
  grade: 'hover' | 'click',
): TileInspectResult {
  const target = doc.elementFromPoint(x, y)
  if (!target) return { ok: false, error: 'No element at this point' }
  const escapeCss = (value: string): string =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
  const nthStep = (el: Element): string => {
    const tag = el.tagName.toLowerCase()
    const parent = el.parentElement
    if (!parent) return tag
    const siblings = Array.prototype.filter.call(
      parent.children,
      (child: Element) => child.tagName === el.tagName,
    ) as Element[]
    return siblings.length === 1 ? tag : `${tag}:nth-of-type(${siblings.indexOf(el) + 1})`
  }
  const parts: string[] = []
  let el: Element | null = target
  while (el && el.tagName.toLowerCase() !== 'html') {
    if (el.id) {
      parts.unshift(`#${escapeCss(el.id)}`)
      break
    }
    const testId = el.getAttribute('data-testid')
    if (testId) {
      parts.unshift(`${el.tagName.toLowerCase()}[data-testid="${escapeCss(testId)}"]`)
      break
    }
    parts.unshift(nthStep(el))
    el = el.parentElement
  }
  const rect = target.getBoundingClientRect()
  const result: TileInspectSuccess = {
    ok: true,
    selector: parts.join(' > ').slice(0, 1024),
    tag: target.tagName.toLowerCase().slice(0, 32),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
  if (grade === 'click') {
    const text = (target.textContent ?? '').trim()
    if (text) result.text = text.slice(0, 512)
    result.snippet = target.outerHTML.slice(0, 2048)
  }
  return result
}

/** Serializes the probe into a one-shot Runtime.evaluate expression. */
export function inspectExpression(x: number, y: number, grade: TileInspectGrade): string {
  // esbuild-based runtimes (tsx, which runs the daemon) rewrite the
  // transpiled function body to wrap inner named functions in
  // `__name(fn, "name")` calls (its `keepNames` transform). `__name` is
  // undefined when this string is evaluated standalone in the page, so the
  // emitted expression shims it — a no-op wrapper — to stay self-contained
  // no matter which runtime produced the stringification.
  return `(() => { var __name = (fn) => fn; return (${inspectPageAt.toString()})(document, ${x}, ${y}, ${JSON.stringify(grade)}); })()`
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Re-validates what the page returned. The evaluated value crosses a trust
 * boundary (the page controls it), so shapes are checked and strings
 * re-truncated server-side.
 */
export function parseTileInspectResult(value: unknown): TileInspectResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.ok === false) {
    return typeof record.error === 'string'
      ? { ok: false, error: record.error.slice(0, 256) }
      : null
  }
  if (record.ok !== true) return null
  const rect = record.rect as Record<string, unknown> | undefined
  if (
    typeof record.selector !== 'string' || record.selector.length === 0 ||
    typeof record.tag !== 'string' || record.tag.length === 0 ||
    typeof rect !== 'object' || rect === null ||
    !finiteNumber(rect.x) || !finiteNumber(rect.y) ||
    !finiteNumber(rect.width) || !finiteNumber(rect.height) ||
    (record.text !== undefined && typeof record.text !== 'string') ||
    (record.snippet !== undefined && typeof record.snippet !== 'string')
  ) {
    return null
  }
  return {
    ok: true,
    selector: record.selector.slice(0, MAX_INSPECT_SELECTOR),
    tag: record.tag.slice(0, MAX_INSPECT_TAG),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ...(record.text !== undefined ? { text: record.text.slice(0, MAX_INSPECT_TEXT) } : {}),
    ...(record.snippet !== undefined ? { snippet: record.snippet.slice(0, MAX_INSPECT_SNIPPET) } : {}),
  }
}
