const MAX_COMPANION_OUTPUT_CHARS = 2_000
const MAX_COMPANION_OUTPUT_LINES = 40

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001bP.*?\u001b\\/gs, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
}

export function companionOutputTail(value: string | undefined): string | undefined {
  if (!value) return undefined
  const lines = stripAnsi(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))

  while (lines[0]?.length === 0) lines.shift()
  while (lines.at(-1)?.length === 0) lines.pop()
  if (lines.length === 0) return undefined

  const tail = lines.slice(-MAX_COMPANION_OUTPUT_LINES).join('\n')
  const bounded = tail.length > MAX_COMPANION_OUTPUT_CHARS
    ? tail.slice(-MAX_COMPANION_OUTPUT_CHARS)
    : tail
  return bounded.replace(/^\n+/, '') || undefined
}
