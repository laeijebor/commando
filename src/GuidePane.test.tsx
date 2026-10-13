// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guideSnapshot, parseGuide, type GuideMark, type GuideSnapshot } from '../shared/guide'
import { GuidePane } from './GuidePane'
import { publishCanvasChange, publishGuideStateChanged } from './webPanesApi'

const artifactId = '0123456789abcdef'
const GUIDE = `# Stripe rollout

## Phase 1

1. **Get the secret.**
   - [ ] Reveal and copy the signing secret {#reveal}
   - [x] Store it in Doppler
   - [ ] Run: {#run-sync}

     \`\`\`sh
     doppler run -- sync
     \`\`\`

\`\`\`sh
pbpaste | doppler secrets set STRIPE_SECRET
\`\`\`

<callout tone="warn" title="Careful">

Live mode only.

</callout>

<checkpoint id="phase-1">Phase 1 done</checkpoint>

<script>window.pwned = true</script>
`

let markdown = GUIDE
let marks: Record<string, GuideMark> = {}
let delivered: Record<string, { checked: boolean; note?: string }> = {}
let waiting = false
const snapshot = (): GuideSnapshot => ({ ...guideSnapshot(parseGuide(markdown), marks, delivered), marks, waiting })
const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/guide.md')) return new Response(markdown)
  if (url.endsWith('/guide/steps')) {
    const body = JSON.parse(String(init?.body)) as { id: string; checked?: boolean; note?: string }
    const current = snapshot().steps.find((step) => step.id === body.id)!
    marks = { ...marks, [body.id]: { checked: body.checked ?? current.checked, ...(body.note ?? current.note ? { note: body.note ?? current.note } : {}), at: 1 } }
  }
  if (url.endsWith('/guide/update') && init?.method === 'POST') waiting = true
  return Response.json({ ok: true, guide: snapshot() })
})

beforeEach(() => {
  markdown = GUIDE; marks = {}; delivered = {}; waiting = false
  fetcher.mockClear()
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const renderGuide = (onTitle = vi.fn()) => render(<GuidePane webPaneId="w-12345678" token="t" artifactId={artifactId} file="guide.md" artifactUrl={`http://127.0.0.1:4410/redline/artifacts/${artifactId}/`} onTitle={onTitle} />)

describe('GuidePane', () => {
  it('renders steps, checkpoints, callouts and copyable code without running scripts', async () => {
    const onTitle = vi.fn()
    const { container } = renderGuide(onTitle)
    expect(await screen.findByRole('checkbox', { name: 'Reveal and copy the signing secret' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Store it in Doppler' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Phase 1 done' })).toBeInTheDocument()
    expect(container.textContent).not.toContain('{#reveal}')
    expect(screen.getByRole('note')).toHaveTextContent('Careful Live mode only.')
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2)
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Run:' })).toBeInTheDocument()
    expect(container.textContent).not.toContain('{#run-sync}')
    expect(screen.getByLabelText('1 of 4 steps done')).toBeInTheDocument()
    expect(onTitle).toHaveBeenCalledWith('Stripe rollout')
  })

  it('ticks a step on the daemon and offers to update the agent', async () => {
    renderGuide()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Reveal and copy the signing secret' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/web-panes/w-12345678/guide/steps', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'reveal', checked: true }) })))
    const update = await screen.findByRole('button', { name: /Update agent \(1\)/ })
    expect(screen.getByText('1 unsent change')).toBeInTheDocument()
    fireEvent.click(update)
    expect(await screen.findByText('Sends when the agent is idle…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled()
  })

  it('saves a note on a step', async () => {
    const { container } = renderGuide()
    await screen.findByRole('checkbox', { name: 'Phase 1 done' })
    const checkpoint = container.querySelector('[data-step-id="phase-1"]') as HTMLElement
    fireEvent.click(within(checkpoint).getByRole('button', { name: 'Add a note to Phase 1 done' }))
    const input = within(checkpoint).getByRole('textbox', { name: 'Note for Phase 1 done' })
    fireEvent.change(input, { target: { value: 'Both endpoints returned 200' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await within(checkpoint).findByRole('button', { name: 'Both endpoints returned 200' })).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledWith('/api/web-panes/w-12345678/guide/steps', expect.objectContaining({ body: JSON.stringify({ id: 'phase-1', note: 'Both endpoints returned 200' }) }))
  })

  it('re-renders agent edits live and keeps ticks by step id', async () => {
    marks = { reveal: { checked: true, at: 1 } }
    renderGuide()
    expect(await screen.findByRole('checkbox', { name: 'Reveal and copy the signing secret' })).toBeChecked()
    markdown = GUIDE.replace('## Phase 1\n', '## Phase 1\n\n- [ ] A new first step\n')
    act(() => publishCanvasChange({ artifactId, changed: ['guide.md'] }))
    expect(await screen.findByRole('checkbox', { name: 'A new first step' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Reveal and copy the signing secret' })).toBeChecked()
  })

  it('reloads tick state when another client changes it', async () => {
    renderGuide()
    await screen.findByRole('checkbox', { name: 'Reveal and copy the signing secret' })
    marks = { reveal: { checked: true, at: 1 } }
    act(() => publishGuideStateChanged({ artifactId, file: 'guide.md' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Reveal and copy the signing secret' })).toBeChecked())
  })
})
