/// <reference types="node" />
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256 } from './sha256'

const vectors = [
  { name: 'empty input', input: '', digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  { name: 'abc', input: 'abc', digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  {
    name: '112-byte multi-block input',
    input: 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn'
      + 'hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    digest: 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  },
  { name: 'UTF-8 text', input: '你好，世界 🌍', digest: 'd45d8cc1a994312f4b8e6647c06aee97738d8b175c96fd304ff090f8fbe12c9a' },
]

describe('sha256', () => {
  it.each(vectors)('hashes $name and matches subtle.digest', async ({ input, digest }) => {
    const bytes = new TextEncoder().encode(input)
    expect(sha256(bytes)).toBe(digest)
    const native = await webcrypto.subtle.digest('SHA-256', bytes)
    expect(sha256(bytes)).toBe(Buffer.from(native).toString('hex'))
  })

  it.each([1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024])(
    'matches subtle.digest for a %i-byte binary view across padding boundaries', async (length) => {
      const backing = Uint8Array.from({ length: length + 4 }, (_, index) => (index * 131) & 0xff)
      const bytes = backing.subarray(2, length + 2)
      const original = backing.slice()
      const native = await webcrypto.subtle.digest('SHA-256', bytes)
      expect(sha256(bytes)).toBe(Buffer.from(native).toString('hex'))
      expect(backing).toEqual(original)
    },
  )
})
