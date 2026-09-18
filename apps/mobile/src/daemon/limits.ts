import { MAX_INPUT_BYTES, MAX_PASTE_BYTES } from '@commando/protocol'

/**
 * The daemon rejects an oversized `paste` or `input` frame outright, so the app
 * checks the same limits — imported from `shared/protocol.ts`, never re-typed —
 * before it sends one. Hermes has no Buffer, so the UTF-8 length is counted
 * directly off the code points.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

export function pasteFits(value: string): boolean {
  return utf8ByteLength(value) <= MAX_PASTE_BYTES
}

export function inputFits(value: string): boolean {
  return utf8ByteLength(value) <= MAX_INPUT_BYTES
}

export { MAX_INPUT_BYTES, MAX_PASTE_BYTES }
