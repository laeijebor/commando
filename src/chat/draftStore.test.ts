// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDraft, saveDraft } from './draftStore'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

const key = (id: string) => `commando:chat-draft:${id}`
const days = (count: number) => count * 24 * 60 * 60 * 1000

describe('saved chat drafts', () => {
  it('round trips text by session and removes an emptied draft', () => {
    saveDraft('first', '  unfinished\nthought 🦉  ')
    saveDraft('second', 'other chat')
    expect(readDraft('first')).toBe('  unfinished\nthought 🦉  ')
    expect(readDraft('second')).toBe('other chat')
    saveDraft('first', '')
    expect(localStorage.getItem(key('first'))).toBeNull()
    expect(readDraft('second')).toBe('other chat')
  })

  it('does nothing until a session has an identity', () => {
    saveDraft(undefined, 'not a pane id')
    expect(readDraft(undefined)).toBe('')
    expect(localStorage.length).toBe(0)
  })

  it('expires drafts after 14 days and prunes only its namespace on saving', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    localStorage.setItem(key('old'), JSON.stringify({ text: 'old', updatedAt: now - days(14) - 1 }))
    localStorage.setItem(key('fresh'), JSON.stringify({ text: 'fresh', updatedAt: now - days(14) }))
    localStorage.setItem('other-setting', 'keep')
    expect(readDraft('old')).toBe('')
    expect(readDraft('fresh')).toBe('fresh')
    saveDraft('current', 'new')
    expect(localStorage.getItem(key('old'))).toBeNull()
    expect(readDraft('fresh')).toBe('fresh')
    expect(localStorage.getItem('other-setting')).toBe('keep')
  })

  it('rejects malformed entries and removes them on the next save', () => {
    const invalid = ['{', 'null', '[]', '"text"', JSON.stringify({ text: 3, updatedAt: Date.now() }), JSON.stringify({ text: 'no timestamp' })]
    invalid.forEach((raw, index) => localStorage.setItem(key(String(index)), raw))
    invalid.forEach((_, index) => expect(readDraft(String(index))).toBe(''))
    saveDraft('valid', 'keep')
    expect(localStorage.length).toBe(1)
  })

  it('caps the stored entry at 100 KB without truncating the in-memory draft', () => {
    const text = '🦉'.repeat(20_000)
    saveDraft('large', text)
    const raw = localStorage.getItem(key('large'))!
    expect(raw.length * 2).toBeLessThanOrEqual(100 * 1024)
    expect(readDraft('large')).toBe(text)
    saveDraft('large', 'x'.repeat(100 * 1024))
    expect(localStorage.getItem(key('large'))).toBeNull()
  })

  it('ignores read, write and removal failures', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Private mode') })
    expect(readDraft('session')).toBe('')
    vi.restoreAllMocks()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    expect(() => saveDraft('session', 'still typing')).not.toThrow()
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Blocked') })
    expect(() => saveDraft('session', '')).not.toThrow()
  })
})
