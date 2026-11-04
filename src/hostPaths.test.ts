import { describe, expect, it, vi } from 'vitest'
import { createHostFetch, daemonPath, daemonWebSocketUrl } from './hostPaths'
import { createTmuxHttpApi } from './tmuxCreateApi'
import { createPrsApi } from './prsApi'
import { createNotesApi } from './notesApi'

describe('daemonPath', () => {
  it.each(['/api/snapshot', '/api/tmux/sessions?name=a%20b', '/ws', '/ws?token=a%2Fb'])('preserves local %s byte-for-byte', (path) => {
    expect(daemonPath(path, 'local')).toBe(path)
  })
  it.each(['/api/snapshot', '/api/tmux/sessions?name=a%20b', '/ws', '/ws?token=a%2Fb'])('maps remote %s through the hub', (path) => {
    expect(daemonPath(path, 'hub-mac')).toBe(`/h/hub-mac${path}`)
  })
  it.each(['/api/hosts', '/api/hosts/hub', '/api/auth/bootstrap', '/api/pairing/start', '/api/sims', '/api/ides/sessions/a', '/api/web-panes/a', '/api/redline/artifacts/a/canvas', '/api/screenshots/a', '/ide/a', '/redline/artifacts/a/', '/screenshots/a/1.png', '/chat-images/a', '/ws/web-tiles/a', '/ws/api/sims/a/live', '/api/pane-management/panes/%251/open'])('never rewrites local-only %s', (path) => {
    expect(daemonPath(path, 'hub')).toBe(path)
  })
  it('only maps daemon paths', () => {
    expect(daemonPath('https://example.com/api/a', 'hub')).toBe('https://example.com/api/a')
    expect(daemonPath('/h/other/api/a', 'hub')).toBe('/h/other/api/a')
  })
  it('uses the current origin, host prefix and existing token format for WebSocket URLs', () => {
    const location = { protocol: 'https:', host: 'localhost:4310' }
    expect(daemonWebSocketUrl('hub', 'a/b', location)).toBe('wss://localhost:4310/h/hub/ws?token=a%2Fb')
    expect(daemonWebSocketUrl('local', '', { ...location, protocol: 'http:' })).toBe('ws://localhost:4310/ws')
  })
  it('blocks local-only fetches remotely and rejects calls from retired workspaces', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const controller = new AbortController()
    const remote = createHostFetch('hub', controller.signal, fetcher)
    await expect(remote('/api/sims')).rejects.toThrow('Only on this Mac for now')
    controller.abort()
    await expect(remote('/api/tmux/sessions', { method: 'POST' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('creates sessions on the viewed host', async () => {
    const created = { kind: 'session', sessionId: '$1', sessionName: 'work', windowId: '@1', windowIndex: 0, windowName: 'shell', paneId: '%1', paneIndex: 0, panePath: '/repo' }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ created }), { status: 201 }))
    await expect(createTmuxHttpApi('owner', createHostFetch('hub', undefined, fetcher)).createSession({ name: 'work' })).resolves.toEqual({ created })
    expect(fetcher).toHaveBeenCalledWith('/h/hub/api/tmux/sessions', expect.objectContaining({ method: 'POST', body: '{"name":"work"}' }))
  })
  it('threads host paths through factories, with PR stores isolated by transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"catalogs":{}}'))
    const remote = createHostFetch('hub', undefined, fetcher)
    await createTmuxHttpApi('', remote).models()
    expect(fetcher).toHaveBeenLastCalledWith(expect.stringMatching(/^\/h\/hub\/api\/tmux\//), expect.anything())
    expect(createPrsApi('', remote).storeKey).not.toBe(createPrsApi('', createHostFetch('local', undefined, fetcher)).storeKey)
    const api = createNotesApi('', remote, (path) => daemonPath(path, 'hub'))
    expect(api.resolveImageUrl('images/12345678-1234-4123-8123-123456789abc/12345678-1234-4123-8123-123456789abc.png', 'v')).toMatch(/^\/h\/hub\/api\/notes\//)
  })
})
