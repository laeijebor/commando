import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlePrsApi } from './prs-api.js'
import { PrService } from './prs.js'

const servers: Server[] = []

const TARGET_ID = '123e4567-e89b-42d3-a456-426614174000'

async function startApi(
  panePath: (paneId: string) => string | undefined,
  paneTargetId: (paneId: string) => string | undefined = () => undefined,
): Promise<string> {
  const gitRunner = vi.fn(async (args: string[]) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return '/workspace\n'
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'feature\n'
    if (args[0] === 'for-each-ref') return 'origin\n'
    if (args.join(' ') === 'remote get-url origin') return 'git@github.com:acme/widgets.git\n'
    throw new Error(`Unexpected git command: ${args.join(' ')}`)
  })
  const service = new PrService({
    runner: vi.fn(async () => JSON.stringify({ data: { linked: { issueCount: 0, nodes: [] } } })),
    gitRunner,
    preferencesPath: '/nonexistent/prs.json',
  })
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!(await handlePrsApi(request, response, url, service, { panePath, paneTargetId }))) {
        response.writeHead(404)
        response.end()
      }
    })()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise((resolve) => server.close(resolve)),
  ))
})

describe('PR pane repository API', () => {
  it('resolves the tracking repository for a daemon-known pane', async () => {
    const base = await startApi((paneId) => paneId === '%1' ? '/workspace/packages/app' : undefined)
    const response = await fetch(`${base}/api/prs/repo?paneId=%251`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ repo: 'acme/widgets' })
  })

  it('rejects invalid and unknown pane ids', async () => {
    const base = await startApi(() => undefined)
    const invalid = await fetch(`${base}/api/prs/repo?paneId=not-a-pane`)
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'invalid_request' })

    const missing = await fetch(`${base}/api/prs/repo?paneId=%251`)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ code: 'pane_not_found' })
  })

  it('rejects unsupported refresh values', async () => {
    const base = await startApi(() => undefined)
    const response = await fetch(`${base}/api/prs?repo=acme%2Fwidgets&state=open&refresh=true`)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' })
  })

  it('resolves pane-linked pull requests through the pane target', async () => {
    const base = await startApi(
      () => '/workspace',
      (paneId) => paneId === '%1' ? TARGET_ID : undefined,
    )
    const response = await fetch(`${base}/api/prs/pane?paneId=%251`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      list: { targetId: TARGET_ID, pullRequests: [] },
    })
  })

  it('rejects invalid and unknown pane ids for pane-linked pull requests', async () => {
    const base = await startApi(() => '/workspace')
    expect((await fetch(`${base}/api/prs/pane?paneId=bad`)).status).toBe(400)
    expect((await fetch(`${base}/api/prs/pane?paneId=%251`)).status).toBe(404)
  })
})
