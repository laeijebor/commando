/** `4m`, `2h`, `3d` — the compact stamps the mockup's rows use. */
export function relativeTime(timestamp: number | undefined, now: number = Date.now()): string {
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
