// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import {
  PINNED_NOTE_STORAGE_KEY,
  pinnedNoteFrom,
  storedPinnedNote,
  storePinnedNote,
} from './pinnedNote'

afterEach(() => window.localStorage.clear())

describe('pinned note persistence', () => {
  it('stores and restores the pinned note snapshot', () => {
    const note = pinnedNoteFrom('vault-1', {
      id: 'note-1',
      title: 'Release checklist',
      body: '- [ ] Verify',
      folder: 'Projects',
      updatedAt: 42,
    })

    storePinnedNote(note)
    expect(storedPinnedNote()).toEqual(note)

    storePinnedNote(null)
    expect(window.localStorage.getItem(PINNED_NOTE_STORAGE_KEY)).toBeNull()
  })

  it('ignores malformed stored values', () => {
    window.localStorage.setItem(PINNED_NOTE_STORAGE_KEY, JSON.stringify({ id: 'missing-fields' }))
    expect(storedPinnedNote()).toBeNull()
  })
})
