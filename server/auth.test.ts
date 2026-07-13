import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configuredAuthSecret,
  configuredOwnerEmail,
  createAuthService,
  type AuthService,
} from './auth.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'commando-auth-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function startAuthServer(service: AuthService): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/auth/')) {
      void service.handle(request, response)
      return
    }
    void service.hasSession(request).then((authorized) => {
      response.writeHead(authorized ? 204 : 401)
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    service.close()
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected an IP test server')
  return { origin: `http://127.0.0.1:${address.port}`, server }
}

describe('Commando authentication', () => {
  it('validates and normalizes the configured owner email', () => {
    expect(configuredOwnerEmail(' Leo@IJEBOR.com ')).toBe('leo@ijebor.com')
    expect(configuredOwnerEmail('')).toBeNull()
    expect(() => configuredOwnerEmail('not-an-email')).toThrow('COMMANDO_OWNER_EMAIL')
  })

  it('persists a private generated Better Auth secret', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'auth.secret')
    const first = await configuredAuthSecret(undefined, path)
    const second = await configuredAuthSecret(undefined, path)

    expect(first).toHaveLength(43)
    expect(second).toBe(first)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('allows only the configured owner to bootstrap and authorizes the session cookie', async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, 'auth.sqlite')
    const service = await createAuthService({
      ownerEmail: 'leo@ijebor.com',
      databasePath,
      secret: 'a'.repeat(32),
      baseURL: 'http://127.0.0.1',
      trustedOrigins: ['http://127.0.0.1'],
    })
    const { origin } = await startAuthServer(service)
    const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' }

    expect(service.bootstrap()).toMatchObject({ needsOwner: true, ownerEmail: 'leo@ijebor.com' })

    const rejected = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Intruder', email: 'other@example.com', password: 'long-enough-password' }),
    })
    expect(rejected.ok).toBe(false)
    expect(service.bootstrap().needsOwner).toBe(true)

    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Leo', email: 'leo@ijebor.com', password: 'long-enough-password' }),
    })
    expect(signup.status).toBe(200)
    const cookie = signup.headers.get('set-cookie')
    expect(cookie).toContain('better-auth.session_token=')
    expect(service.bootstrap().needsOwner).toBe(false)

    const protectedResponse = await fetch(`${origin}/protected`, {
      headers: { Cookie: cookie! },
    })
    expect(protectedResponse.status).toBe(204)
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600)
  })
})
