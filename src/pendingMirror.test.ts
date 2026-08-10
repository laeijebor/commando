import { describe, expect, it } from 'vitest'
import { MAX_PENDING_NOTES, type WebPanePendingNote } from '../shared/protocol'
import { loadPendingMirror, savePendingMirror } from './pendingMirror'

function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

function note(id: number, comment = 'align this'): WebPanePendingNote {
  return {
    id,
    revision: 1,
    selector: '#root > button',
    tag: 'button',
    rect: { x: 1, y: 2, width: 30, height: 10 },
    comment,
    attachments: [],
  }
}

describe('pending mirror', () => {
  it('round-trips notes per pane', () => {
    const storage = fakeStorage()
    savePendingMirror('w-11111111', [note(1), { ...note(2), queueKey: 'q1', response: { question: 'q', answer: 'a' } }], storage)
    savePendingMirror('w-22222222', [note(9, 'other pane')], storage)
    const restored = loadPendingMirror('w-11111111', storage)
    expect(restored.map((entry) => entry.id)).toEqual([1, 2])
    expect(restored[1]?.queueKey).toBe('q1')
    expect(restored[1]?.response).toEqual({ question: 'q', answer: 'a' })
    expect(loadPendingMirror('w-22222222', storage).map((entry) => entry.comment)).toEqual(['other pane'])
  })

  it('accepts legacy and revised notes while omitting attachment capabilities', () => {
    const storage = fakeStorage()
    storage.setItem('commando.redline.pending.w-11111111', JSON.stringify([
      {
        id: 1,
        selector: '#legacy',
        tag: 'div',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        comment: 'legacy',
      },
      {
        ...note(2),
        revision: 7,
        attachments: [{ id: 'private.png', name: 'private.png', contentType: 'image/png', size: 10 }],
        response: { question: 'q', answer: 'a', note: 'context', data: { value: 1 } },
      },
    ]))
    const restored = loadPendingMirror('w-11111111', storage)
    expect(restored[0]).toMatchObject({ revision: 1, attachments: [] })
    expect(restored[1]).toMatchObject({
      revision: 7,
      attachments: [],
      response: { question: 'q', answer: 'a', note: 'context', data: { value: 1 } },
    })
  })

  it('does not write attachment references into localStorage', () => {
    const storage = fakeStorage()
    savePendingMirror('w-11111111', [{
      ...note(1),
      attachments: [{ id: 'private.png', name: 'private.png', contentType: 'image/png', size: 10 }],
    }], storage)
    expect(storage.getItem('commando.redline.pending.w-11111111')).not.toContain('private.png')
  })

  it('an empty save clears the entry', () => {
    const storage = fakeStorage()
    savePendingMirror('w-11111111', [note(1)], storage)
    savePendingMirror('w-11111111', [], storage)
    expect(storage.length).toBe(0)
    expect(loadPendingMirror('w-11111111', storage)).toEqual([])
  })

  it('tolerates missing, corrupt, and malformed entries', () => {
    const storage = fakeStorage()
    expect(loadPendingMirror('w-11111111', storage)).toEqual([])
    storage.setItem('commando.redline.pending.w-11111111', 'not json')
    expect(loadPendingMirror('w-11111111', storage)).toEqual([])
    storage.setItem(
      'commando.redline.pending.w-11111111',
      JSON.stringify([note(1), { comment: 'no selector' }, { ...note(2), response: 'bad' }]),
    )
    expect(loadPendingMirror('w-11111111', storage).map((entry) => entry.id)).toEqual([1])
  })

  it('caps a tampered oversized mirror', () => {
    const storage = fakeStorage()
    const notes = Array.from({ length: MAX_PENDING_NOTES + 10 }, (_, index) => note(index + 1))
    storage.setItem('commando.redline.pending.w-11111111', JSON.stringify(notes))
    expect(loadPendingMirror('w-11111111', storage)).toHaveLength(MAX_PENDING_NOTES)
  })

  it('survives an absent storage', () => {
    expect(loadPendingMirror('w-11111111', null)).toEqual([])
    expect(() => savePendingMirror('w-11111111', [note(1)], null)).not.toThrow()
  })
})
