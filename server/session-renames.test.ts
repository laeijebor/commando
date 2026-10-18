import { describe, expect, it } from 'vitest'

import { detectSessionRenames } from './session-renames.js'

const previousSessions = [{ id: '$1', name: 'billing' }]
const nextSessions = [{ id: '$1', name: 'chat' }]

describe('detectSessionRenames', () => {
  it('detects a rename of the same session on the same server', () => {
    expect(detectSessionRenames(
      { serverId: '100:1', sessions: previousSessions },
      { serverId: '100:1', sessions: nextSessions },
    )).toEqual([{ sessionId: '$1', previousName: 'billing', name: 'chat' }])
  })

  it('ignores reused session ids when retrying discovery on a new server', () => {
    // A failed discovery may change tmux.serverId while the stored snapshot stays old.
    expect(detectSessionRenames(
      { serverId: '100:1', sessions: previousSessions },
      { serverId: '200:2', sessions: nextSessions },
    )).toEqual([])
  })

  it.each([
    [null, '100:1'],
    ['100:1', null],
    [null, null],
    ['', '100:1'],
    ['100:1', ''],
    ['', ''],
  ])('ignores renames with unknown server ids (%s, %s)', (previousServerId, nextServerId) => {
    expect(detectSessionRenames(
      { serverId: previousServerId, sessions: previousSessions },
      { serverId: nextServerId, sessions: nextSessions },
    )).toEqual([])
  })

  it('ignores unchanged, added, and removed sessions', () => {
    expect(detectSessionRenames(
      { serverId: '100:1', sessions: [...previousSessions, { id: '$2', name: 'removed' }] },
      { serverId: '100:1', sessions: [...previousSessions, { id: '$3', name: 'added' }] },
    )).toEqual([])
  })
})
