import { expect, it } from 'vitest'
import { hostProxyRoute } from './hosts-proxy.js'
import { cleanHeaders, HOST_RESPONSE_SECURITY } from './hosts-transport.js'

it('delegates only API and WS paths and removes local query credentials', () => {
  const route = (path: string) => hostProxyRoute(new URL(path, 'http://localhost'))
  expect(route('/h/hub-1/api/x?token=local&other=1')).toEqual({ id: 'hub-1', path: '/api/x?other=1', ws: false })
  expect(route('/h/hub/ws')).toEqual({ id: 'hub', path: '/ws', ws: true })
  for (const path of ['/h/hub/api', '/h/hub/other', '/h/hub/ws/other', '/h/hub/api/../../private', '/h/%2f/api/x', '/h/hub/h/other/api/x']) expect(route(path)).toBeNull()
})

it('strips credentials, browser context and named hop-by-hop headers in both directions', () => {
  const headers = { authorization: 'local', cookie: 'local', origin: 'http://localhost', referer: 'local', host: 'local', connection: 'keep-alive, x-private', 'x-private': 'secret', 'keep-alive': 'timeout=5', 'proxy-authorization': 'secret', 'sec-websocket-protocol': 'commando-auth.local', 'content-type': 'text/plain' }
  expect(cleanHeaders(headers, true)).toEqual({ 'content-type': 'text/plain' })
  expect(cleanHeaders({ 'set-cookie': ['secret=1'], connection: 'x-private', 'x-private': 'secret', 'content-type': 'text/plain' }, false)).toEqual({ 'content-type': 'text/plain' })
})

it('uses the shared filter to strip WS upgrade hop headers before ws regenerates its handshake', () => {
  expect(cleanHeaders({ connection: 'Upgrade, x-private', upgrade: 'websocket', 'x-private': 'hidden', 'x-application': 'forwarded' }, true)).toEqual({ 'x-application': 'forwarded' })
})

it('replaces remote content policies with the local sandbox and nosniff headers', () => {
  const headers = cleanHeaders({ 'content-security-policy': "script-src * 'unsafe-inline'", 'x-content-type-options': 'unsafe', 'content-type': 'text/html' }, false)
  expect({ ...headers, ...HOST_RESPONSE_SECURITY }).toEqual({
    'content-type': 'text/html',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
  })
})
