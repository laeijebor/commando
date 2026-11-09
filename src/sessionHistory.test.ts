import { describe, expect, it } from 'vitest'
import { emptyHistory, goTo, parseHistory, recordVisit, serialiseHistory, stepTarget } from './sessionHistory'

const visit = (sessionId: string) => ({ sessionId, name: `Session ${sessionId}`, at: 100 })
const trail = (...ids: string[]) => ids.reduce((history, id) => recordVisit(history, visit(id)), emptyHistory())

describe('session history', () => {
  it('ignores re-selection, retains non-consecutive visits, and does not mutate the old trail', () => {
    const history = trail('a', 'b')
    expect(recordVisit(history, visit('b'))).toBe(history)
    expect(recordVisit(history, visit('a')).entries.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'a'])
    expect(history.entries).toHaveLength(2)
  })

  it('moves without truncation and drops the forward branch only on a new visit', () => {
    const history = trail('a', 'b', 'c')
    const back = goTo(history, 0)
    expect(back.entries).toBe(history.entries)
    expect(goTo(back, 2)).toEqual(history)
    expect(recordVisit(back, visit('d'))).toEqual({ entries: [visit('a'), visit('d')], index: 1 })
    expect(recordVisit(back, visit('a'))).toBe(back)
    for (const index of [-1, 3, 1.5, NaN]) expect(goTo(history, index)).toBe(history)
  })

  it('caps at 50 and drops the oldest entries', () => {
    const history = trail(...Array.from({ length: 55 }, (_, index) => String(index)))
    expect(history.entries).toHaveLength(50)
    expect(history.entries[0].sessionId).toBe('5')
    expect(history.index).toBe(49)
  })

  it('skips missing sessions in both directions and handles boundaries', () => {
    const history = trail('a', 'gone', 'b', 'also-gone', 'c')
    const live = (id: string) => !id.includes('gone')
    expect(stepTarget(history, -1, live)).toBe(2)
    expect(stepTarget(goTo(history, 0), 1, live)).toBe(2)
    expect(stepTarget(history, 1, live)).toBeNull()
    expect(stepTarget(goTo(history, 0), -1, live)).toBeNull()
    expect(stepTarget(history, -1, () => false)).toBeNull()
    expect(stepTarget(emptyHistory(), 1, live)).toBeNull()
  })

  it('skips earlier or later visits to the current session when the intervening session is closed', () => {
    const history = trail('alpha', 'beta', 'alpha')
    const live = (id: string) => id !== 'beta'
    expect(stepTarget(history, -1, live)).toBeNull()
    expect(stepTarget(goTo(history, 0), 1, live)).toBeNull()

    const extended = trail('gamma', 'alpha', 'beta', 'alpha', 'delta')
    expect(stepTarget(goTo(extended, 3), -1, live)).toBe(0)
    expect(stepTarget(goTo(extended, 1), 1, live)).toBe(4)
  })

  it('round-trips an intermediate position and normalizes duplicate/oversized storage', () => {
    const history = goTo(trail('a', 'b', 'c'), 1)
    expect(parseHistory(serialiseHistory(history))).toEqual(history)
    expect(parseHistory(JSON.stringify({ entries: [visit('a'), visit('a'), visit('b')], index: 1 })))
      .toEqual({ entries: [visit('a'), visit('b')], index: 0 })
    const entries = Array.from({ length: 60 }, (_, index) => visit(String(index)))
    expect(parseHistory(JSON.stringify({ entries, index: 58 }))).toEqual({ entries: entries.slice(10), index: 48 })
  })

  it.each([null, '', 'junk', 'null', '{}', '[]', '{"entries":[],"index":4}',
    JSON.stringify({ entries: [visit('a')], index: -1 }),
    JSON.stringify({ entries: [visit('a')], index: 1 }),
    JSON.stringify({ entries: [visit('a')], index: 0.5 }),
    JSON.stringify({ entries: [{ sessionId: 4, name: 'a', at: 1 }], index: 0 }),
    JSON.stringify({ entries: [{ sessionId: 'a', at: 1 }], index: 0 }),
    JSON.stringify({ entries: [{ ...visit('a'), at: -1 }], index: 0 }),
    JSON.stringify({ entries: [null], index: 0 }),
  ])('tolerates junk storage: %s', (raw) => {
    expect(parseHistory(raw)).toEqual(emptyHistory())
  })

  it('rejects non-finite stored timestamps', () => {
    expect(parseHistory('{"entries":[{"sessionId":"a","name":"a","at":1e999}],"index":0}')).toEqual(emptyHistory())
  })
})
