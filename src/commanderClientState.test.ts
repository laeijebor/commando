import { describe, expect, it } from 'vitest'
import type { CommanderRelay, TurnBrief } from '../shared/commander'
import { initialCommanderClientState as initial, reduceCommanderMessage as reduce } from './commanderClientState'

const relay = (id: string, createdAt = 1, status: CommanderRelay['status'] = 'queued') => ({ id, createdAt, status }) as CommanderRelay
const brief = (targetId: string, text: string) => ({ targetId, text }) as TurnBrief

describe('Commander client messages', () => {
  it('upserts briefs by stable target and replaces them on reconnect', () => {
    let state = reduce(initial, { type: 'turn_brief', brief: brief('a', 'first') })
    state = reduce(state, { type: 'turn_brief', brief: brief('a', 'updated') })
    expect(state.turnBriefs).toEqual({ a: brief('a', 'updated') })
    expect(reduce(state, { type: 'turn_brief_snapshot', briefs: [brief('b', 'fresh')] }).turnBriefs).toEqual({ b: brief('b', 'fresh') })
  })
  it('updates a receipt by id and bounds history by creation time rather than update order', () => {
    const state = reduce(initial, { type: 'commander_relay_snapshot', relays: Array.from({ length: 205 }, (_, i) => relay(String(i), i)) })
    expect(Object.keys(state.relays)).toHaveLength(200)
    expect(state.relays['0']).toBeUndefined()
    const updated = reduce(state, { type: 'commander_relay', relay: relay('204', 204, 'delivered') })
    expect(Object.keys(updated.relays)).toHaveLength(200)
    expect(updated.relays['204'].status).toBe('delivered')
    expect(reduce(updated, { type: 'commander_relay_snapshot', relays: [] }).relays).toEqual({})
  })
  it('replaces Commander state including removal', () => {
    const state = reduce(initial, { type: 'commander_state', state: { targetId: 'target', paneId: '%1', sessionId: '$1' } })
    expect(state.commanderState.paneId).toBe('%1')
    expect(reduce(state, { type: 'commander_state', state: { targetId: null } }).commanderState).toEqual({ targetId: null })
  })
})
