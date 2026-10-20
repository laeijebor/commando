export const ATS_BLOCKED = 'iOS App Transport Security blocked this HTTP connection (-1022). Rebuild Commando with the updated Tailscale networking permissions.'
export function isAtsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return typeof error === 'string' && /-1022|App Transport Security/i.test(error)
  const value = error as { code?: unknown; message?: unknown; cause?: unknown; domain?: unknown }
  return Number(value.code) === -1022 || /-1022|App Transport Security/i.test(String(value.message ?? '')) || (value.cause !== undefined && value.cause !== error && isAtsError(value.cause))
}
export function networkErrorMessage(error: unknown): string {
  return isAtsError(error) ? ATS_BLOCKED : error instanceof Error ? error.message : 'Unreachable'
}
