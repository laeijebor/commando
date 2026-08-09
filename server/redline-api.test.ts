import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isRedlinePath, RedlineApi } from './redline-api.js'
import { RedlineArtifactRegistry } from './redline-artifacts.js'

const AGENT_TOKEN = 'agent-hook-token-with-at-least-32-characters'
const REDLINE_BASE_URL = 'http://127.0.0.1:4310'
const servers: Server[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function artifactDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'redline-api-'))
  temporaryDirectories.push(dir)
  await writeFile(join(dir, 'index.html'), '<h1>hi</h1>')
  return dir
}

async function startApi(): Promise<{ baseUrl: string; artifacts: RedlineArtifactRegistry }> {
  const artifacts = new RedlineArtifactRegistry()
  const api = new RedlineApi({
    agentToken: AGENT_TOKEN,
    ownerAuthorized: async (request) => request.headers['x-test-owner'] === 'yes',
    artifacts,
    baseUrl: REDLINE_BASE_URL,
  })
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, artifacts }
}

function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Issues a request with a literal, unnormalized path — `fetch`/`URL` would collapse `..` segments before the request ever reaches the server, defeating a test of the server's own traversal guard. */
function rawGet(baseUrl: string, rawPath: string): Promise<{ status: number }> {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path: rawPath, method: 'GET' }, (response) => {
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode ?? 0 }))
    })
    request.on('error', reject)
    request.end()
  })
}

const agentAuth = { Authorization: `Bearer ${AGENT_TOKEN}` }

describe('isRedlinePath', () => {
  it('matches /redline and /api/redline paths only', () => {
    expect(isRedlinePath('/redline/sdk.js')).toBe(true)
    expect(isRedlinePath('/api/redline/artifacts')).toBe(true)
    expect(isRedlinePath('/api/web-panes')).toBe(false)
  })
})

describe('RedlineApi static routes', () => {
  it('serves the scoped default artifact theme', async () => {
    const { baseUrl } = await startApi()
    const response = await fetch(`${baseUrl}/redline/design/default.css`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/css/)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = await response.text()
    expect(body).toContain('@layer redline-default')
    expect(body).toContain('html[data-redline-theme="commando"]')
    expect(body).toContain('.redline-panel')
    expect(body).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('serves daisyui.css', async () => {
    const { baseUrl } = await startApi()
    const response = await fetch(`${baseUrl}/redline/design/daisyui.css`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/css/)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = await response.text()
    expect(body.length).toBeGreaterThan(0)
  })

  it('serves tailwind.js', async () => {
    const { baseUrl } = await startApi()
    const response = await fetch(`${baseUrl}/redline/design/tailwind.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/javascript/)
  })

  it('serves a mermaid dist chunk', async () => {
    const { baseUrl } = await startApi()
    const response = await fetch(`${baseUrl}/redline/design/mermaid/mermaid.esm.min.mjs`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/javascript/)
  })

  it('blocks traversal under the mermaid dist tree', async () => {
    const { baseUrl } = await startApi()
    const response = await rawGet(baseUrl, '/redline/design/mermaid/../../package.json')
    expect(response.status).toBe(404)
  })

  it('serves the redline sdk placeholder', async () => {
    const { baseUrl } = await startApi()
    const response = await fetch(`${baseUrl}/redline/sdk.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/javascript/)
  })

  it('404s unknown static paths and 405s wrong methods', async () => {
    const { baseUrl } = await startApi()
    const notFound = await fetch(`${baseUrl}/redline/nope`)
    expect(notFound.status).toBe(404)
    const wrongMethod = await fetch(`${baseUrl}/redline/sdk.js`, { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET')
  })
})

describe('RedlineApi artifact routes', () => {
  it('registers, serves, and unregisters an artifact directory with agent auth', async () => {
    const { baseUrl } = await startApi()
    const dir = await artifactDir()

    const registerResponse = await post(baseUrl, '/api/redline/artifacts', { dir }, agentAuth)
    expect(registerResponse.status).toBe(201)
    const registered = await registerResponse.json() as { ok: boolean; id: string; url: string }
    expect(registered.ok).toBe(true)
    expect(registered.url).toBe(`${REDLINE_BASE_URL}/redline/artifacts/${registered.id}/`)

    const fileResponse = await fetch(`${baseUrl}/redline/artifacts/${registered.id}/index.html`)
    expect(fileResponse.status).toBe(200)
    expect(fileResponse.headers.get('content-type')).toMatch(/^text\/html/)

    const deleteResponse = await fetch(`${baseUrl}/api/redline/artifacts/${registered.id}`, {
      method: 'DELETE',
      headers: agentAuth,
    })
    expect(deleteResponse.status).toBe(200)
    expect(await deleteResponse.json()).toEqual({ ok: true })

    const afterDelete = await fetch(`${baseUrl}/redline/artifacts/${registered.id}/index.html`)
    expect(afterDelete.status).toBe(404)
  })

  it('rejects registration without auth or with a bad token', async () => {
    const { baseUrl } = await startApi()
    const dir = await artifactDir()

    const noAuth = await post(baseUrl, '/api/redline/artifacts', { dir })
    expect(noAuth.status).toBe(401)

    const badToken = await post(baseUrl, '/api/redline/artifacts', { dir }, {
      Authorization: 'Bearer wrong-token-that-is-long-enough-to-check',
    })
    expect(badToken.status).toBe(401)
  })

  it('rejects a non-absolute dir', async () => {
    const { baseUrl } = await startApi()
    const response = await post(baseUrl, '/api/redline/artifacts', { dir: 'relative' }, agentAuth)
    expect(response.status).toBe(400)
  })
})
