import { act, render, screen } from '@testing-library/react-native'

import type { Host } from '../hosts/types'
import {
  GIT_SUMMARY,
  NEEDS_INPUT_STATUS,
  PANE_PRS,
  SNAPSHOT,
  WORKLOG_BRIEF,
} from '../testing/fixtures'
import { ThemeProvider } from '../theme'
import { PaneInfo } from './PaneInfo'

const HOST: Host = {
  id: 'h1',
  name: 'studio',
  baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
  auth: { kind: 'token', token: 'secret' },
}

const requested: string[] = []

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  requested.length = 0
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/api/git/summary')) return jsonResponse(GIT_SUMMARY)
    if (url.includes('/api/prs/pane')) return jsonResponse({ list: PANE_PRS })
    return jsonResponse({})
  }) as unknown as typeof fetch
})

async function renderSheet(): Promise<void> {
  render(
    <ThemeProvider>
      <PaneInfo
        brief={WORKLOG_BRIEF}
        host={HOST}
        onClose={() => undefined}
        pane={SNAPSHOT.panes[0]}
        paneId="%14"
        ports={SNAPSHOT.ports}
        sessionName="commando"
        status={NEEDS_INPUT_STATUS}
      />
    </ThemeProvider>,
  )
  // Let the theme read and the two fetches settle before asserting.
  await act(async () => undefined)
}

describe('the pane Info sheet', () => {
  it('heads the sheet with the session, provider, pane and status', async () => {
    await renderSheet()
    expect(screen.getByText(/commando · Claude/u)).toBeTruthy()
    expect(screen.getByText(/%14/u)).toBeTruthy()
    expect(screen.getByText('Needs you')).toBeTruthy()
  })

  it('offers a chip for every section', async () => {
    await renderSheet()
    for (const label of ['Worklog', 'Changes', 'PR', 'Ports', 'Screenshots']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('renders the worklog headline, recap, next action and plan progress', async () => {
    await renderSheet()
    expect(screen.getByText('Add an owner-auth answer channel for the companion')).toBeTruthy()
    expect(screen.getByText('buildCompanionSnapshot')).toBeTruthy()
    expect(screen.getByText('Wire answer_agent_request on /ws')).toBeTruthy()
    // Four of the seven tasks that count are done; the cancelled one is shown
    // but never counted.
    expect(screen.getByText('4 / 7')).toBeTruthy()
    expect(screen.getByText('Rewrite the tile proxy')).toBeTruthy()
  })

  it('lists the activity newest first', async () => {
    await renderSheet()
    const timeline = screen.getAllByText(/vitest · 41 passed|Keep the hook token|rejects non-loopback/u)
    expect(timeline.map((node) => node.props.children)).toEqual([
      'vitest · 41 passed',
      'Keep the hook token separate from owner sessions',
      '/companion/ws rejects non-loopback peers',
    ])
  })

  it('reads the diff, the pull request and the ports from the daemon', async () => {
    await renderSheet()
    expect(requested.some((url) => url.includes('/api/git/summary?paneId=%2514'))).toBe(true)
    expect(requested.some((url) => url.includes('/api/prs/pane?paneId=%2514'))).toBe(true)
    expect(screen.getByText('+212 −48 · 4 files · ⎇ feat/companion-app')).toBeTruthy()
    expect(screen.getByText('protocol.ts')).toBeTruthy()
    expect(screen.getByText('feat: owner-auth companion channel')).toBeTruthy()
    expect(screen.getByText(':4310')).toBeTruthy()
    expect(screen.getByText('Open as tile')).toBeTruthy()
  })

  it('shows the screenshot folder from the brief', async () => {
    await renderSheet()
    expect(screen.getByText(/answer-channel/u)).toBeTruthy()
    expect(screen.getByLabelText('Open sheet.png')).toBeTruthy()
  })
})
