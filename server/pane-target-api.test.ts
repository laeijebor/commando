import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { PaneTargetApi } from './pane-target-api.js'

const TOKEN = 'a'.repeat(32)
const TARGET = '550e8400-e29b-41d4-a716-446655440000'
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function request(options: { token?: string; pane?: string; method?: string } = {}) {
  const api = new PaneTargetApi({
    token: TOKEN,
    paneTarget: (paneId) => paneId === '%42' ? { targetId: TARGET } : null,
  })
  const server = createServer((incoming, response) => {
    api.handle(incoming, response, new URL(incoming.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind')
  return fetch(`http://127.0.0.1:${address.port}/api/pane-target-marker`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${options.token ?? TOKEN}`,
      'X-Commando-Pane': options.pane ?? '%42',
    },
  })
}

describe('pane target marker API', () => {
  it('returns the canonical marker for the authenticated live pane', async () => {
    const response = await request()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      targetId: TARGET,
      marker: `<!-- commando:v1 target=${TARGET} relation=created -->`,
    })
  })

  it('rejects unauthorized, malformed, and missing panes', async () => {
    expect((await request({ token: 'b'.repeat(32) })).status).toBe(401)
    expect((await request({ pane: '42' })).status).toBe(400)
    expect((await request({ pane: '%99' })).status).toBe(404)
    expect((await request({ method: 'POST' })).status).toBe(405)
  })
})
