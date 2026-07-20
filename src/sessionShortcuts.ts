type SessionShortcutEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>

export function sessionShortcutIndex(event: SessionShortcutEvent): number | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return null
  return Number(event.key) - 1
}
