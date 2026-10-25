import type { Host } from '../hosts/types'
import { cancelGuideUpdate, fetchGuide, fetchGuideMarkdown, markGuideStep, requestGuideUpdate, resetGuide } from './api'

const HOST: Host = { id: 'h1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
const GUIDE = { title: 'T', steps: [], marks: {}, changes: [], waiting: false }
const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = []

beforeEach(() => {
  calls.length = 0
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(input), method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}), ...(headers.Authorization ? { auth: headers.Authorization } : {}) })
    if (String(input).includes('/redline/')) return new Response('# Guide\n', { status: 200 })
    if (String(input).endsWith('/update') && init?.method === 'POST') return new Response(JSON.stringify({ error: 'There are no changes to send' }), { status: 409 })
    return new Response(JSON.stringify({ ok: true, guide: GUIDE }), { status: 200 })
  }) as unknown as typeof fetch
})

it('calls the daemon’s guide routes with the desktop’s payloads', async () => {
  await fetchGuide(HOST, 'w-0000abcd')
  await markGuideStep(HOST, 'w-0000abcd', { id: 'copy', checked: true })
  await markGuideStep(HOST, 'w-0000abcd', { id: 'copy', note: 'done on staging' })
  await cancelGuideUpdate(HOST, 'w-0000abcd')
  await resetGuide(HOST, 'w-0000abcd')
  expect(calls).toEqual([
    { url: 'http://studio:4310/api/web-panes/w-0000abcd/guide', method: 'GET', auth: 'Bearer secret' },
    { url: 'http://studio:4310/api/web-panes/w-0000abcd/guide/steps', method: 'POST', body: '{"id":"copy","checked":true}', auth: 'Bearer secret' },
    { url: 'http://studio:4310/api/web-panes/w-0000abcd/guide/steps', method: 'POST', body: '{"id":"copy","note":"done on staging"}', auth: 'Bearer secret' },
    { url: 'http://studio:4310/api/web-panes/w-0000abcd/guide/update', method: 'DELETE', auth: 'Bearer secret' },
    { url: 'http://studio:4310/api/web-panes/w-0000abcd/guide/reset', method: 'POST', body: '{}', auth: 'Bearer secret' },
  ])
})

it('surfaces the daemon’s error message', async () => {
  await expect(requestGuideUpdate(HOST, 'w-0000abcd')).rejects.toThrow('There are no changes to send')
  expect(calls[0]).toMatchObject({ method: 'POST', body: '{}' })
})

it('reads the Markdown from the artifact folder the daemon serves', async () => {
  await expect(fetchGuideMarkdown(HOST, { artifactId: '0123456789abcdef', file: '.guides/run.md' })).resolves.toBe('# Guide\n')
  expect(calls[0]!.url).toBe('http://studio:4310/redline/artifacts/0123456789abcdef/.guides/run.md')
})
