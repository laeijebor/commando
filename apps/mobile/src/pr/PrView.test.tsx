import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'

import { demoPrDetails, demoPrDiff, demoPrPreview } from '../demo/prDetail'
import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { PrView } from './PrView'

const HOST: Host = { id: 'pr-view', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
const requested: string[] = []
let generation = 0

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  // A fresh host id per case keeps the shared PR cache from leaking between tests.
  HOST.id = `pr-view-${++generation}`
  requested.length = 0
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/api/prs/details')) return json({ details: demoPrDetails() })
    if (url.includes('/api/prs/diff')) return json({ diff: demoPrDiff() })
    return json({})
  }) as unknown as typeof fetch
})
afterEach(cleanup)

async function renderView(preview = true): Promise<void> {
  render(
    <ThemeProvider>
      <PrView host={HOST} source={{ repo: 'leo/commando', number: 257, title: 'Bring remote chat to the companion', url: 'https://github.com/leo/commando/pull/257', state: 'open', isDraft: false, ...(preview ? { preview: demoPrPreview() } : {}) }} />
    </ThemeProvider>,
  )
  await act(async () => undefined)
}

it('shows the header, readiness and the description without hidden markers', async () => {
  await renderView()
  expect(screen.getByText('Bring remote chat to the companion')).toBeTruthy()
  expect(screen.getByText(/feat\/remote-chat/u)).toBeTruthy()
  expect(screen.getByText('changes requested')).toBeTruthy()
  expect(screen.getByText('2 unresolved')).toBeTruthy()
  expect(screen.getByText('e2e (playwright)')).toBeTruthy()
  expect(screen.getByText('Summary')).toBeTruthy()
  expect(screen.queryByText(/commando:v1/u)).toBeNull()
  expect(screen.getByLabelText('Open #257 on GitHub')).toBeTruthy()
  // The diff waits for its tab.
  expect(requested.some((url) => url.includes('/api/prs/details?repo=leo%2Fcommando&number=257'))).toBe(true)
  expect(requested.some((url) => url.includes('/api/prs/diff'))).toBe(false)
})

it('lists changed files and expands one into numbered, coloured lines', async () => {
  await renderView()
  fireEvent.press(screen.getByText('Diff · 6'))
  await act(async () => undefined)
  expect(requested.filter((url) => url.includes('/api/prs/diff'))).toEqual(['http://studio:4310/api/prs/diff?repo=leo%2Fcommando&number=257&base=pr'])
  expect(screen.getByText(/6 files ·/u)).toBeTruthy()
  expect(screen.getByText(/against main/u)).toBeTruthy()
  expect(screen.queryByText(/return <Terminal/u)).toBeNull()
  fireEvent.press(screen.getByLabelText('apps/mobile/src/chat/ChatView.tsx, modified, 12 added, 3 removed'))
  // Default text matching collapses the patch's indentation.
  expect(screen.getByText(/^- return <Terminal/u)).toBeTruthy()
  // Switching away and back reuses the copy pinned to this head.
  fireEvent.press(screen.getByText('Description'))
  fireEvent.press(screen.getByText('Diff · 6'))
  await act(async () => undefined)
  expect(requested.filter((url) => url.includes('/api/prs/diff'))).toHaveLength(1)
})

it('draws a long patch in chunks and a binary file as a GitHub link', async () => {
  await renderView()
  fireEvent.press(screen.getByText('Diff · 6'))
  await act(async () => undefined)
  fireEvent.press(screen.getByLabelText('apps/mobile/src/chat/__fixtures__/timeline.ts, added, 1000 added, 0 removed'))
  expect(screen.getByText(/TIMELINE_FIXTURE_298 /u)).toBeTruthy()
  expect(screen.queryByText(/TIMELINE_FIXTURE_299 /u)).toBeNull()
  fireEvent.press(screen.getByText('Show 300 more lines · 701 left'))
  expect(screen.getByText(/TIMELINE_FIXTURE_299 /u)).toBeTruthy()
  fireEvent.press(screen.getByLabelText('apps/mobile/assets/chat-empty.png, added, 0 added, 0 removed'))
  expect(screen.getByText(/GitHub sends no text diff for this file/u)).toBeTruthy()
})

it('shows the conversation with review states, threads, replies and folded resolved threads', async () => {
  await renderView()
  fireEvent.press(screen.getByText('Conversation · 7'))
  expect(screen.getByText('2 comments · 2 reviews · 3 threads, 2 unresolved')).toBeTruthy()
  expect(screen.getByLabelText('Review by ocean-otter: changes requested')).toBeTruthy()
  expect(screen.getByLabelText('Review thread on apps/mobile/src/chat/ChatView.tsx:21')).toBeTruthy()
  expect(screen.getAllByLabelText(/^Reply by /u)).toHaveLength(2)
  // The resolved, outdated thread starts folded.
  expect(screen.getByLabelText('Review thread on apps/mobile/src/chat/Markdown.tsx:140, resolved, outdated')).toBeTruthy()
  expect(screen.queryByText('Code should scroll sideways rather than wrap.')).toBeNull()
  fireEvent.press(screen.getByText(/2 comments · tap to show/u))
  expect(screen.getByText('Code should scroll sideways rather than wrap.')).toBeTruthy()
  fireEvent.press(screen.getByText('Unresolved threads only'))
  expect(screen.queryByText(/leo/u, { exact: false })).toBeNull()
  expect(screen.queryByLabelText(/Markdown\.tsx:140/u)).toBeNull()
})

it('falls back to the repository PR list when the pane sent no preview', async () => {
  ;(globalThis.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/api/prs/details')) return json({ details: demoPrDetails() })
    if (url.includes('/api/prs?')) return json({ list: { pullRequests: [demoPrPreview()] } })
    return json({})
  })
  await renderView(false)
  expect(requested.some((url) => url.includes('/api/prs?repo=leo%2Fcommando&state=all&scope=everyone'))).toBe(true)
  expect(screen.getByText(/by emerald-crab · 9 commits/u)).toBeTruthy()
})
