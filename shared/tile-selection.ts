/// <reference lib="dom" />

export type TileSelectionSource = 'dom' | 'input' | 'textarea' | 'none'
export type TileSelectionSuccess = {
  ok: true
  source: TileSelectionSource
  text: string
}
export type TileSelectionFailure = { ok: false; error: string }
export type TileSelectionResult = TileSelectionSuccess | TileSelectionFailure

export const MAX_TILE_SELECTION_TEXT = 65_536

/**
 * Reads the page's effective text selection. This function is stringified for
 * Runtime.evaluate, so it must remain self-contained and use browser globals only.
 */
export function readPageSelection(doc: Document): TileSelectionResult {
  const readDocument = (currentDocument: Document): TileSelectionResult => {
    let active = currentDocument.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement

    if (active?.tagName.toLowerCase() === 'iframe') {
      try {
        const frameDocument = (active as HTMLIFrameElement).contentDocument
        if (frameDocument) return readDocument(frameDocument)
      } catch {
        // Cross-origin frame selection is unavailable from this execution context.
      }
    }

    const tag = active?.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea') {
      const control = active as HTMLInputElement | HTMLTextAreaElement
      if (tag === 'input' && (control as HTMLInputElement).type.toLowerCase() === 'password') {
        return { ok: false, error: 'Copying password selections is not supported' }
      }
      const start = control.selectionStart
      const end = control.selectionEnd
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
        return { ok: true, source: 'none', text: '' }
      }
      const text = control.value.slice(start, end)
      if (text.length > 65_536) return { ok: false, error: 'Selection is too large to copy' }
      return { ok: true, source: tag as 'input' | 'textarea', text }
    }

    const selection = currentDocument.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return { ok: true, source: 'none', text: '' }
    }
    const text = selection.toString()
    if (text.length > 65_536) return { ok: false, error: 'Selection is too large to copy' }
    return { ok: true, source: text ? 'dom' : 'none', text }
  }

  try {
    return readDocument(doc)
  } catch {
    return { ok: false, error: 'Page threw while reading its selection' }
  }
}

/** Serializes the selection probe into a one-shot Runtime.evaluate expression. */
export function selectionExpression(): string {
  return `(() => { var __name = (fn) => fn; return (${readPageSelection.toString()})(document); })()`
}

/** Re-validates the untrusted value returned by the page. */
export function parseTileSelectionResult(value: unknown): TileSelectionResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.ok === false) {
    return typeof record.error === 'string'
      ? { ok: false, error: record.error.slice(0, 256) }
      : null
  }
  if (
    record.ok !== true ||
    (record.source !== 'dom' && record.source !== 'input' && record.source !== 'textarea' && record.source !== 'none') ||
    typeof record.text !== 'string' ||
    record.text.length > MAX_TILE_SELECTION_TEXT ||
    (record.source === 'none' && record.text !== '')
  ) {
    return null
  }
  return { ok: true, source: record.source, text: record.text }
}
