import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionBrief } from '../shared/protocol.js'
import { SessionBriefApi } from './session-brief-api.js'
import { SessionBriefStore } from './session-briefs.js'
import { PaneScreenshotRegistry } from './pane-screenshots.js'

const token = 'session-brief-hook-token-that-is-at-least-32-characters'
let server: Server
let baseUrl: string
let directory: string
let changes: SessionBrief[]
let store: SessionBriefStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'commando-session-brief-api-'))
  store = new SessionBriefStore(join(directory, 'briefs.json'))
  changes = []
  const api = new SessionBriefApi({
    token,
    store,
    screenshots: new PaneScreenshotRegistry({ statePath: join(directory, 'screenshots.json'), now: () => 123 }),
    paneTarget: (paneId) => paneId === '%1'
      ? { sessionId: '$1', sessionName: 'commando' }
      : null,
    onChange: (brief) => changes.push(brief),
    now: () => 123,
  })
  server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
      .then((handled) => {
        if (!handled) {
          response.statusCode = 404
          response.end()
        }
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await rm(directory, { recursive: true, force: true })
})

function post(body: unknown, options: { token?: string; paneId?: string } = {}) {
  return fetch(`${baseUrl}/api/session-brief`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token ?? token}`,
      'Content-Type': 'application/json',
      'X-Commando-Pane': options.paneId ?? '%1',
    },
    body: JSON.stringify(body),
  })
}

describe('SessionBriefApi', () => {
  it('records a bounded agent-authored update for the source pane', async () => {
    const response = await post({
      headline: 'Dry run verified',
      recapMarkdown: 'Validated the **footer capsule**.',
      next: 'Review screenshots',
      update: { kind: 'check', text: 'All checks passed', detail: 'typecheck and Vitest' },
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { brief: SessionBrief }
    expect(body.brief).toMatchObject({
      paneId: '%1',
      sessionId: '$1',
      sessionName: 'commando',
      headline: 'Dry run verified',
      headlineSource: 'agent',
      recapMarkdown: 'Validated the **footer capsule**.',
      next: 'Review screenshots',
      updatedAt: 123,
    })
    expect(body.brief.updates[0]).toMatchObject({ paneId: '%1', kind: 'check', source: 'agent' })
    expect(store.get('%1')).toEqual(body.brief)
    expect(changes).toEqual([body.brief])
  })

  it('rejects unauthorized, unknown-pane, and malformed updates', async () => {
    await expect(post({ headline: 'No' }, { token: 'wrong' })).resolves.toMatchObject({ status: 401 })
    await expect(post({ headline: 'No' }, { paneId: '%99' })).resolves.toMatchObject({ status: 404 })
    await expect(post({ update: { kind: 'script', text: 'No' } })).resolves.toMatchObject({ status: 400 })
    await expect(post({ recapMarkdown: 'x'.repeat(2_001) })).resolves.toMatchObject({ status: 400 })
    expect(changes).toHaveLength(0)
  })

  it('publishes an absolute screenshot directory and rejects relative or missing paths', async () => {
    const shots = join(await realpath(directory), 'shots')
    await mkdir(shots)
    await writeFile(join(shots, 'one.png'), 'png')

    const response = await post({ screenshots: { dir: shots } })
    expect(response.status).toBe(200)
    const body = await response.json() as { brief: SessionBrief }
    expect(body.brief.screenshots?.[0]).toMatchObject({ dir: shots, topic: 'shots', imageCount: 1 })
    expect(body.brief.updates[0]).toMatchObject({
      kind: 'screenshots',
      screenshotFolderId: body.brief.screenshots?.[0]?.id,
      source: 'agent',
      text: 'Published shots · 1 images',
    })

    await expect(post({ screenshots: { dir: 'relative/shots' } })).resolves.toMatchObject({ status: 400 })
    await expect(post({ screenshots: { dir: join(directory, 'missing') } })).resolves.toMatchObject({ status: 400 })
  })
})
