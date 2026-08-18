export type CommandoPrMarker = {
  version: 1
  targetId: string
  relation: 'created'
}

const TARGET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MARKER_PATTERN = /<!-- commando:v1 target=([0-9a-f-]+) relation=created -->/g

export function isCommandoTargetId(value: unknown): value is string {
  return typeof value === 'string' && TARGET_ID_PATTERN.test(value)
}

export function formatCommandoPrMarker(targetId: string): string {
  if (!isCommandoTargetId(targetId)) throw new Error('Invalid Commando target id')
  return `<!-- commando:v1 target=${targetId} relation=created -->`
}

export function parseCommandoPrMarker(body: string): CommandoPrMarker | null {
  const targetIds = new Set<string>()
  for (const match of body.matchAll(MARKER_PATTERN)) {
    if (isCommandoTargetId(match[1])) targetIds.add(match[1])
  }
  if (targetIds.size !== 1) return null
  return { version: 1, targetId: [...targetIds][0], relation: 'created' }
}

export function stripCommandoPrMarkers(body: string): string {
  return body.replace(MARKER_PATTERN, '').replace(/\n{3,}/g, '\n\n')
}
