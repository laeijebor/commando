import { describe, expect, it } from 'vitest'

import {
  formatCommandoPrMarker,
  isCommandoTargetId,
  parseCommandoPrMarker,
  stripCommandoPrMarkers,
} from './pane-target.js'

const TARGET = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_TARGET = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'

describe('Commando PR markers', () => {
  it('formats and parses the canonical v1 marker', () => {
    const marker = formatCommandoPrMarker(TARGET)

    expect(marker).toBe(`<!-- commando:v1 target=${TARGET} relation=created -->`)
    expect(parseCommandoPrMarker(`Summary\n\n${marker}\n`)).toEqual({
      version: 1,
      targetId: TARGET,
      relation: 'created',
    })
  })

  it('accepts duplicate identical markers but rejects conflicting targets', () => {
    const marker = formatCommandoPrMarker(TARGET)
    expect(parseCommandoPrMarker(`${marker}\n${marker}`)?.targetId).toBe(TARGET)
    expect(parseCommandoPrMarker(`${marker}\n${formatCommandoPrMarker(OTHER_TARGET)}`)).toBeNull()
  })

  it('rejects malformed ids, versions, relations, and extra attributes', () => {
    expect(isCommandoTargetId(TARGET)).toBe(true)
    expect(isCommandoTargetId(TARGET.toUpperCase())).toBe(false)
    expect(parseCommandoPrMarker('<!-- commando:v1 target=%42 relation=created -->')).toBeNull()
    expect(parseCommandoPrMarker(`<!-- commando:v2 target=${TARGET} relation=created -->`)).toBeNull()
    expect(parseCommandoPrMarker(`<!-- commando:v1 target=${TARGET} relation=worked_on -->`)).toBeNull()
    expect(parseCommandoPrMarker(`<!-- commando:v1 target=${TARGET} relation=created extra=yes -->`)).toBeNull()
  })

  it('removes canonical markers from visible PR excerpts', () => {
    expect(stripCommandoPrMarkers(`Summary\n\n${formatCommandoPrMarker(TARGET)}\n`)).toBe('Summary\n\n')
  })
})
