/** A place in a file to open the session IDE at: 1-based line and, optionally, 1-based column. */
export type IdeFilePosition = { line: number; column?: number }

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

/** Reads a position from untrusted input; undefined when there is none or it is malformed. */
export function parseIdeFilePosition(line: unknown, column: unknown): IdeFilePosition | undefined {
  if (!positive(line)) return undefined
  return positive(column) ? { line, column } : { line }
}

/**
 * The `:line:column` suffix VS Code's goto-line mode reads from a file URI's path
 * (`gotoLineMode: true` on the CLI server's `open` message, or the workbench's
 * `gotoLineMode` payload entry). VS Code splits the decoded path on `:` and takes
 * the first numeric segments as line and column, so a path that already has a
 * numeric (or empty) segment between colons would be misread: such paths get no
 * suffix and open at the top instead.
 */
export function ideGotoSuffix(path: string, position: IdeFilePosition | undefined): string {
  if (!position || path.split(':').some((segment) => !Number.isNaN(Number(segment)))) return ''
  return `:${position.line}${position.column ? `:${position.column}` : ''}`
}
