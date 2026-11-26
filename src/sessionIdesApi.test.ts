import { expect, it, vi } from 'vitest'
import { createSessionIdesApi } from './sessionIdesApi'

it('sends an optional line and column with a file to open', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  const api = createSessionIdesApi('token', fetcher as unknown as typeof fetch)
  expect(await api.openFile('$1', '/w/a.ts')).toBe('opened')
  expect(await api.openFile('$1', '/w/a.ts', { line: 12, column: 5 })).toBe('opened')
  const bodies = fetcher.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string))
  expect(bodies).toEqual([{ path: '/w/a.ts' }, { path: '/w/a.ts', line: 12, column: 5 }])
})
