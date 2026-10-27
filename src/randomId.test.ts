import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUuid } from './randomId'

afterEach(() => vi.unstubAllGlobals())

describe('randomUuid', () => {
  it('uses the native randomUUID with its crypto receiver when available', () => {
    const uuid = 'f581fbee-0b4d-4ba6-96a8-c921e823715d'
    const randomUUID = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis.crypto)
      return uuid
    })
    const getRandomValues = vi.fn()
    vi.stubGlobal('crypto', { randomUUID, getRandomValues })
    expect(randomUuid()).toBe(uuid)
    expect(randomUUID).toHaveBeenCalledOnce()
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  it('uses the existing 16-byte lowercase hex fallback on plain HTTP', () => {
    const getRandomValues = vi.fn(function (this: unknown, bytes: Uint8Array) {
      expect(this).toBe(globalThis.crypto)
      expect(bytes).toHaveLength(16)
      bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 254, 255])
      return bytes
    })
    vi.stubGlobal('crypto', { getRandomValues })
    expect(randomUuid()).toBe('000102030405060708090a0b0c0dfeff')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
})
