import { useDaemonStore } from '../daemon/store'
import { fakeClient } from '../chat/testing'
import { useSessionPreferences } from './sessionPreferences'
beforeEach(() => useSessionPreferences.setState({ seen: {} }))
it('ingests daemon snapshots and merges broadcasts without consulting the device clock', () => {
  useDaemonStore.getState().ingest('h1', { type: 'pane_seen', snapshot: true, seen: { '%14': 100 } })
  useDaemonStore.getState().ingest('h1', { type: 'pane_seen', seen: { '%15': 200 } })
  expect(useSessionPreferences.getState().seen.h1).toEqual({ '%14': 100, '%15': 200 })
  useDaemonStore.getState().ingest('h1', { type: 'pane_seen', snapshot: true, seen: { '%15': 300 } })
  expect(useSessionPreferences.getState().seen.h1).toEqual({ '%15': 300 })
})
it('sends a mark request when viewed and waits for the daemon timestamp', () => {
  const client = fakeClient()
  useSessionPreferences.getState().visit('h1', '%14', client)
  expect(client.last('mark_panes_seen')).toMatchObject({ paneIds: ['%14'] })
  expect(useSessionPreferences.getState().seen).toEqual({})
})
