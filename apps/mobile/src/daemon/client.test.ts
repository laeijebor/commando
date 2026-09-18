import { nextRequestId, retryDelay } from './client'
import {
  inputFits,
  MAX_INPUT_BYTES,
  MAX_PASTE_BYTES,
  pasteFits,
  utf8ByteLength,
} from './limits'

describe('reconnect backoff', () => {
  it('doubles from 500ms and caps at 15s', () => {
    expect(retryDelay(1)).toBe(500)
    expect(retryDelay(2)).toBe(1_000)
    expect(retryDelay(4)).toBe(4_000)
    expect(retryDelay(6)).toBe(15_000)
    expect(retryDelay(40)).toBe(15_000)
  })
})

describe('nextRequestId', () => {
  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextRequestId()))
    expect(ids.size).toBe(50)
  })
})

describe('payload limits', () => {
  it('counts UTF-8 bytes, not code units', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('✎')).toBe(3)
    expect(utf8ByteLength('🟢')).toBe(4)
  })

  it('uses the caps the daemon enforces', () => {
    expect(MAX_PASTE_BYTES).toBe(256 * 1024)
    expect(MAX_INPUT_BYTES).toBe(8 * 1024)
    expect(pasteFits('a'.repeat(MAX_PASTE_BYTES))).toBe(true)
    expect(pasteFits('a'.repeat(MAX_PASTE_BYTES + 1))).toBe(false)
    expect(inputFits('🟢'.repeat(MAX_INPUT_BYTES / 4))).toBe(true)
    expect(inputFits('🟢'.repeat(MAX_INPUT_BYTES / 4 + 1))).toBe(false)
  })
})
