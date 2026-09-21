import { applyServerMessage, EMPTY_HOST_STATE, parseServerMessage } from './state'
import { useDaemonStore } from './store'
import {
  BRIEFS,
  DONE_STATUS,
  NEEDS_INPUT_STATUS,
  SNAPSHOT,
  SNAPSHOT_MESSAGE,
  STATUS_SNAPSHOT_MESSAGE,
  USAGE,
  WORKING_STATUS,
} from '../testing/fixtures'

describe('parseServerMessage', () => {
  it('accepts a well-formed frame', () => {
    expect(parseServerMessage(JSON.stringify(SNAPSHOT_MESSAGE))?.type).toBe('snapshot')
  })

  it('ignores malformed frames and binary payloads', () => {
    expect(parseServerMessage('{ not json')).toBeNull()
    expect(parseServerMessage(JSON.stringify({ nope: true }))).toBeNull()
    expect(parseServerMessage(JSON.stringify([1, 2, 3]))).toBeNull()
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull()
  })

  it('passes a message type it has never seen through to the reducer', () => {
    const message = parseServerMessage(JSON.stringify({ type: 'pane_flavour', flavour: 'new' }))
    expect(message?.type).toBe('pane_flavour')
    expect(applyServerMessage(EMPTY_HOST_STATE, message!)).toBe(EMPTY_HOST_STATE)
  })
})

describe('applyServerMessage', () => {
  it('stores the snapshot', () => {
    const state = applyServerMessage(EMPTY_HOST_STATE, SNAPSHOT_MESSAGE)
    expect(state.snapshot?.revision).toBe(41)
    expect(state.snapshot?.panes).toHaveLength(5)
  })

  it('replaces the whole status map on a status snapshot', () => {
    const stale = applyServerMessage(EMPTY_HOST_STATE, {
      type: 'agent_status',
      status: { ...DONE_STATUS, paneId: '%99' },
    })
    const state = applyServerMessage(stale, STATUS_SNAPSHOT_MESSAGE)
    expect(Object.keys(state.agentStatuses).sort()).toEqual(['%14', '%20', '%30', '%40'])
  })

  it('upserts a single status without touching the others', () => {
    const base = applyServerMessage(EMPTY_HOST_STATE, STATUS_SNAPSHOT_MESSAGE)
    const state = applyServerMessage(base, {
      type: 'agent_status',
      status: { ...WORKING_STATUS, status: 'done', summary: 'Retry landed' },
    })
    expect(state.agentStatuses['%20']?.status).toBe('done')
    expect(state.agentStatuses['%14']).toBe(NEEDS_INPUT_STATUS)
  })

  it('removes a status and leaves an unknown pane alone', () => {
    const base = applyServerMessage(EMPTY_HOST_STATE, STATUS_SNAPSHOT_MESSAGE)
    const removed = applyServerMessage(base, { type: 'agent_status_removed', paneId: '%20' })
    expect(removed.agentStatuses['%20']).toBeUndefined()
    expect(applyServerMessage(removed, { type: 'agent_status_removed', paneId: '%20' })).toBe(removed)
  })

  it('keys session briefs by pane', () => {
    const state = applyServerMessage(EMPTY_HOST_STATE, {
      type: 'session_brief',
      brief: BRIEFS['%40']!,
    })
    expect(state.briefs['%40']?.headline).toBe('🟢 Visor shortcut works on non-notch Macs')
  })

  it('keeps the latest provider usage', () => {
    const state = applyServerMessage(EMPTY_HOST_STATE, { type: 'provider_usage', usage: USAGE })
    expect(state.usage).toHaveLength(3)
    expect(state.usage[0]?.windows[0]?.remainingPercent).toBe(58)
  })

  it('records daemon errors without dropping anything else', () => {
    const base = applyServerMessage(EMPTY_HOST_STATE, SNAPSHOT_MESSAGE)
    const state = applyServerMessage(base, {
      type: 'error',
      code: 'unauthorized',
      message: 'Owner session expired',
      requestId: 'm-1',
    })
    expect(state.lastError).toMatchObject({ code: 'unauthorized', message: 'Owner session expired' })
    expect(state.snapshot).toBe(base.snapshot)
  })
})

describe('the per-host store', () => {
  beforeEach(() => {
    useDaemonStore.setState({ byHost: {} })
  })

  it('keeps two hosts apart', () => {
    const { ingest } = useDaemonStore.getState()
    ingest('host-a', SNAPSHOT_MESSAGE)
    ingest('host-a', STATUS_SNAPSHOT_MESSAGE)
    ingest('host-b', { type: 'provider_usage', usage: USAGE })

    const state = useDaemonStore.getState().byHost
    expect(state['host-a']?.snapshot?.revision).toBe(SNAPSHOT.revision)
    expect(Object.keys(state['host-a']?.agentStatuses ?? {})).toHaveLength(4)
    expect(state['host-b']?.snapshot).toBeNull()
    expect(state['host-b']?.usage).toHaveLength(3)
  })

  it('tracks the connection phase and clears a host on reset', () => {
    const { setPhase, reset, ingest } = useDaemonStore.getState()
    ingest('host-a', SNAPSHOT_MESSAGE)
    setPhase('host-a', 'live', 'Live · studio')
    expect(useDaemonStore.getState().byHost['host-a']?.phase).toBe('live')
    reset('host-a')
    expect(useDaemonStore.getState().byHost['host-a']).toBeUndefined()
  })
})
