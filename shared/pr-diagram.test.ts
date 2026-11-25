import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prDiagramCaption, prDiagramHash, sha256Hex } from './pr-diagram.js'

describe('sha256Hex', () => {
  it('matches node crypto for empty, ASCII, Unicode and multi-block input', () => {
    for (const text of ['', 'abc', 'é ☃ 𝄞', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(70_000)]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    }
  })

  it('hashes a fence by its trimmed source', () => {
    expect(prDiagramHash('\n {"type":"x"} \n')).toBe(sha256Hex('{"type":"x"}'))
  })
})

describe('prDiagramCaption', () => {
  it('reads the title and type of a document', () => {
    expect(prDiagramCaption('{"type":"pipeline","title":" Ship it "}')).toEqual({ type: 'pipeline', title: 'Ship it' })
  })

  it('returns nothing for invalid JSON or a non-object', () => {
    expect(prDiagramCaption('{"type":')).toEqual({})
    expect(prDiagramCaption('[1]')).toEqual({})
    expect(prDiagramCaption('{"title":3}')).toEqual({})
  })
})
