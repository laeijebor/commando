import { daemonFetch, probeHost } from './api'
import { ACCESS_REVOKED } from './access'
import { useHostsStore } from './store'
import { useDaemonStore } from '../daemon/store'
import type { Host } from './types'
import { ATS_BLOCKED } from './networkErrors'
const host: Host = { id: 'test-host', name: 'Mac', baseUrl: 'http://100.72.39.66:4411', auth: { kind: 'token', token: 'secret' } }
const fetchMock = fetch as jest.Mock
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
  useHostsStore.setState({ hosts: [host], reachability: {}, cookies: {} })
  useDaemonStore.setState({ byHost: {} })
})
it('omits credentials for every token-host request and preserves cookies for session hosts', async () => {
  await daemonFetch(host, '/api/health')
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer secret' } })
  await daemonFetch({ ...host, auth: { kind: 'session' } }, '/api/health')
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: 'include' })
})
it('marks a token host revoked on any authenticated HTTP 401', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  await daemonFetch(host, '/api/snapshot')
  expect(useHostsStore.getState().reachability[host.id]).toMatchObject({ state: 'unauthorized', message: ACCESS_REVOKED })
  expect(useDaemonStore.getState().byHost[host.id]).toMatchObject({ phase: 'unauthorized', detail: ACCESS_REVOKED })
})
it('reports revoked health credentials and specific ATS probe failures', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  expect(await probeHost(host)).toMatchObject({ state: 'unauthorized', message: ACCESS_REVOKED })
  fetchMock.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: -1022 }))
  expect(await probeHost(host)).toMatchObject({ state: 'offline', message: ATS_BLOCKED })
})
it('does not allow a stale 401 response to revoke replacement credentials', async () => {
  useHostsStore.setState({ hosts: [{ ...host, auth: { kind: 'token', token: 'replacement' } }] })
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  await daemonFetch(host, '/api/snapshot')
  expect(useHostsStore.getState().reachability[host.id]).toBeUndefined()
})
