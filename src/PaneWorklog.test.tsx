// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentResume, SessionBrief } from '../shared/protocol'
import { PaneWorklog } from './PaneWorklog'

const brief: SessionBrief = {
  paneId: '%12',
  sessionId: '$1',
  sessionName: 'commando',
  state: 'working',
  headline: 'Building pane worklog',
  headlineSource: 'agent',
  recapMarkdown: 'Keeping **history** visible.',
  tasks: [
    { id: 'map', content: 'Map current behavior', status: 'completed', priority: 'high' },
    { id: 'build', content: 'Build pane-local UI', status: 'in_progress', priority: 'high' },
    { id: 'verify', content: 'Verify the flow', status: 'pending', priority: 'medium' },
    { id: 'old', content: 'Discard old direction', status: 'cancelled', priority: 'low' },
  ],
  updates: [
    { id: 'user', paneId: '%12', kind: 'note', text: 'Keep it chat-like', author: 'user', source: 'hook', createdAt: 30 },
    { id: 'new', paneId: '%12', kind: 'decision', text: 'Use a pane-local split', source: 'agent', createdAt: 20 },
    { id: 'old', paneId: '%12', kind: 'check', text: 'Current flow mapped', source: 'hook', createdAt: 10 },
  ],
  next: 'Verify the running app',
  updatedAt: 20,
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('PaneWorklog', () => {
  it('shows saved history as inactive until fresh hooks reconnect', () => {
    const view = render(<PaneWorklog brief={brief} paneLabel="Tests" hookConnected={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByRole('status')).toHaveTextContent('Saved worklog restored')
    expect(screen.getByLabelText('Worklog for Tests')).toHaveClass('state-stale')
    expect(screen.getByText('Map current behavior')).toBeInTheDocument()
    view.rerender(<PaneWorklog brief={brief} paneLabel="Tests" hookConnected />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Worklog for Tests')).toHaveClass(`state-${brief.state}`)
  })

  it('shows an automatic resume in place of the restore hint, and retries a failed one', () => {
    const resume: AgentResume = {
      targetId: '11111111-1111-4111-8111-111111111111', paneId: '%12', provider: 'claude',
      command: 'env claude --resume ba080dbd-899d-41d3-a94d-44032d806009', state: 'resuming', updatedAt: 1,
    }
    const onRetryResume = vi.fn()
    const view = render(<PaneWorklog brief={brief} paneLabel="Tests" hookConnected={false} resume={resume} onRetryResume={onRetryResume} />)
    expect(screen.getByLabelText('Resuming the Claude conversation…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByRole('status')).toHaveTextContent('Resuming the Claude conversation…')
    expect(screen.queryByText(/Saved worklog restored/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()

    view.rerender(<PaneWorklog brief={brief} paneLabel="Tests" hookConnected={false} resume={{ ...resume, state: 'failed', error: 'The folder no longer exists: /repo' }} onRetryResume={onRetryResume} />)
    expect(screen.getAllByRole('status')[0]).toHaveTextContent("Couldn't resume the Claude conversation. The folder no longer exists: /repo")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryResume).toHaveBeenCalledOnce()
  })

  it('folds earlier conversations below the current one and can type their resume command', () => {
    const onTypeCommand = vi.fn()
    render(<PaneWorklog
      brief={{
        ...brief,
        agentSession: { provider: 'claude', id: 'bbbbbbbb-2222-4222-8222-222222222222' },
        earlierSessions: [{
          agentSession: { provider: 'claude', id: 'aaaaaaaa-1111-4111-8111-111111111111' },
          headline: 'Login fix',
          recapMarkdown: 'Fixed the **token refresh**.',
          tasks: [{ id: 'a', content: 'Refresh eagerly', status: 'completed', priority: 'high' }],
          references: [{ kind: 'session', value: 'claudep --resume aaaaaaaa-1111-4111-8111-111111111111' }],
          updates: [{ id: 'old', paneId: '%12', kind: 'decision', text: 'Refresh tokens eagerly', source: 'agent', createdAt: 5 }],
          endedAt: 6,
        }],
      }}
      paneLabel="Tests"
      onTypeCommand={onTypeCommand}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    const earlier = screen.getByLabelText('Earlier sessions for Tests')
    expect(earlier).toHaveTextContent('Login fix')
    expect(earlier).toHaveTextContent('Claude · ended')
    expect(earlier).toHaveTextContent('1/1 tasks')
    expect(screen.getByLabelText('Activity for Tests')).not.toHaveTextContent('Refresh tokens eagerly')
    fireEvent.click(earlier.querySelector('summary')!)
    expect(earlier).toHaveTextContent('Refresh tokens eagerly')
    fireEvent.click(within(earlier).getByRole('button', { name: /claudep --resume/ }))
    expect(onTypeCommand).toHaveBeenCalledWith('claudep --resume aaaaaaaa-1111-4111-8111-111111111111')
  })

  it('renders a simulator first, counts it with references and handles both actions', async () => {
    const simulator = { udid: 'sim-uuid', originalName: 'iPhone 17 Pro', label: 'Session · Check checkout', task: 'Check checkout', sessionName: 'Session', branch: 'feature/checkout', ports: [{ name: 'metro', port: 8101 }, { name: 'backend', port: 3001 }], idle: true }
    const simsApi = { open: vi.fn().mockResolvedValue({ ok: true, raised: true }) }
    const onShowSimulator = vi.fn()
    render(<PaneWorklog brief={{ ...brief, simulator, references: [{ kind: 'feature_flag', value: 'checkout' }] }} paneLabel="Tests" simsApi={simsApi} onShowSimulator={onShowSimulator} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    const section = screen.getByLabelText('Important terms for Tests')
    expect(section.querySelector('header small')).toHaveTextContent('2')
    expect(section.querySelector('.pane-worklog-reference-list')?.firstElementChild).toHaveTextContent(simulator.task)
    const claim = section.querySelector('.pane-worklog-simulator')!
    expect(claim.querySelector('strong')).toHaveTextContent(/^Check checkout$/)
    expect(claim.querySelector('strong + small')).toHaveTextContent(/^iPhone 17 Pro$/)
    expect(section).toHaveTextContent('feature/checkout')
    expect(section).toHaveTextContent('metro :8101')
    expect(section).toHaveTextContent('backend :3001')
    expect(section).toHaveTextContent('idle')
    fireEvent.click(screen.getByRole('button', { name: 'Open Simulator' }))
    await waitFor(() => expect(simsApi.open).toHaveBeenCalledWith(simulator.udid))
    fireEvent.click(screen.getByRole('button', { name: 'Show beside pane' }))
    expect(onShowSimulator).toHaveBeenCalledWith(simulator.udid)
  })

  it('uses the session as the title without a task and shows the activation/raise reason next to the button', async () => {
    const simulator = { udid: 'sim-uuid', originalName: 'iPhone 17 Pro', label: 'Session simulator', task: '', sessionName: 'Session', ports: [], idle: false }
    const simsApi = { open: vi.fn().mockResolvedValueOnce({ ok: true, raised: false, reason: 'Simulator activated, but Accessibility permission was denied.' }).mockResolvedValueOnce({ ok: true, raised: true }) }
    render(<PaneWorklog brief={{ ...brief, simulator }} paneLabel="Tests" simsApi={simsApi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    const claim = screen.getByLabelText('Important terms for Tests').querySelector('.pane-worklog-simulator')!
    expect(claim.querySelector('strong')).toHaveTextContent(/^Session$/)
    expect(claim.querySelector('strong + small')).toHaveTextContent(/^iPhone 17 Pro$/)
    fireEvent.click(screen.getByRole('button', { name: 'Open Simulator' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Simulator activated, but Accessibility permission was denied.')
    expect(screen.getByRole('alert').closest('.pane-worklog-simulator')).toBe(claim)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Simulator' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Open Simulator' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('shows claims without references or activity, reports open failures and removes released claims', async () => {
    const simulator = { udid: 'sim-uuid', originalName: 'iPhone 17 Pro', label: 'Session', task: 'Review', sessionName: 'Session', ports: [], idle: false }
    const simsApi = { open: vi.fn().mockRejectedValue(new Error('Simulator is not booted')) }
    const view = render(<PaneWorklog brief={{ ...brief, references: [], tasks: [], updates: [], simulator }} empty paneLabel="Tests" simsApi={simsApi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByLabelText('Important terms for Tests').querySelector('header small')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: 'Open Simulator' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Simulator is not booted')
    view.rerender(<PaneWorklog brief={{ ...brief, references: [], tasks: [], updates: [] }} empty paneLabel="Tests" />)
    expect(screen.queryByLabelText('Important terms for Tests')).toBeNull()
  })

  it('shows flags and clickable labeled URLs above the scrollable activity', () => {
    render(<PaneWorklog brief={{ ...brief, references: [
      { kind: 'feature_flag', value: 'new-checkout' },
      { kind: 'url', value: 'http://localhost:5273/checkout', label: 'Checkout preview' },
    ] }} paneLabel="Tests" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    const section = screen.getByLabelText('Important terms for Tests')
    expect(section).toHaveTextContent('new-checkout')
    expect(section).toHaveTextContent('Feature flag')
    expect(screen.getByRole('link', { name: /Checkout preview/ })).toHaveAttribute('href', 'http://localhost:5273/checkout')
    expect(screen.getByRole('link', { name: /Checkout preview/ })).toHaveAttribute('target', '_blank')
  })

  it('types the resume command without Enter and copies it separately', async () => {
    const onTypeCommand = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const command = 'opencode --yolo -s ses_f08700672ffenN8gLm9kPx2xb6'
    render(<PaneWorklog brief={{ ...brief, references: [{ kind: 'session', value: command }] }} paneLabel="Tests" onTypeCommand={onTypeCommand} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Resume session.*${command}`) }))
    expect(onTypeCommand).toHaveBeenCalledWith(command)
    fireEvent.click(screen.getByRole('button', { name: 'Copy resume command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command))
    expect(onTypeCommand).toHaveBeenCalledTimes(1)
  })

  it('disables the resume click while offline', () => {
    render(<PaneWorklog brief={{ ...brief, references: [{ kind: 'session', value: 'claudep --resume x1234567' }] }} paneLabel="Tests" connected={false} onTypeCommand={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByRole('button', { name: /Resume session/ })).toBeDisabled()
  })

  it('renders issue and deployment links and linked or plain build/release identifiers', () => {
    render(<PaneWorklog brief={{ ...brief, references: [
      { kind: 'issue', value: 'https://github.com/acme/app/issues/42', label: 'Bug #42' },
      { kind: 'deployment', value: 'https://preview.example.com/', label: 'Checkout preview' },
      { kind: 'build', value: '1842', url: 'https://ci.example.com/build/1842' },
      { kind: 'release', value: 'v2.3.0' },
    ] }} paneLabel="Tests" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByRole('link', { name: /Bug #42/ })).toHaveAttribute('href', 'https://github.com/acme/app/issues/42')
    expect(screen.getByRole('link', { name: /Checkout preview/ })).toHaveAttribute('href', 'https://preview.example.com/')
    expect(screen.getByRole('link', { name: /1842/ })).toHaveAttribute('href', 'https://ci.example.com/build/1842')
    expect(screen.getByText('v2.3.0').closest('.pane-worklog-reference')).not.toHaveAttribute('href')
    expect(screen.getByLabelText('Important terms for Tests')).toHaveTextContent('Release')
  })
  it('migrates notes to durable ownership and retains them across session moves', () => {
    const targetId = '550e8400-e29b-41d4-a716-446655440000'
    window.localStorage.setItem('commando.pane-worklog.$1:%12', JSON.stringify({ note: 'Keep my note', minimized: false, visibilitySet: true }))
    const view = render(<PaneWorklog brief={{ ...brief, targetId }} paneLabel="Tests" />)
    expect(screen.getByRole('textbox', { name: 'Note for Tests' })).toHaveValue('Keep my note')
    expect(window.localStorage.getItem('commando.pane-worklog.$1:%12')).toBeNull()
    view.unmount()
    render(<PaneWorklog brief={{ ...brief, targetId, sessionId: '$2', sessionName: 'moved' }} paneLabel="Tests" />)
    expect(screen.getByRole('textbox', { name: 'Note for Tests' })).toHaveValue('Keep my note')
  })

  it('shows linked PRs and missing-hook guidance without activity metadata', async () => {
    const prsApi = { pane: vi.fn().mockResolvedValue({
      targetId: 'target', totalCount: 1, truncated: false, fetchedAt: Date.now(),
      pullRequests: [{ repo: 'acme/app', number: 1, title: 'Linked work', url: 'https://example.test/pr/1', state: 'open', isDraft: false, createdAt: '2026-01-01', updatedAt: '2026-01-02', additions: 10, deletions: 2, checks: null, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null }],
    }) }
    render(<PaneWorklog brief={{ ...brief, tasks: [], updates: [] }} empty hookConnected={false} paneLabel="Tests" prsApi={prsApi} />)
    expect(await screen.findByLabelText('Open pull request')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByRole('status')).toHaveTextContent('No agent hook data received')
    expect(screen.getByLabelText('Pull requests for pane %12')).toHaveTextContent('Linked work')
  })

  it('starts minimized when the pane has no saved preference', () => {
    render(<PaneWorklog brief={brief} paneLabel="Tests" />)

    expect(screen.getByLabelText('Minimized worklog for Tests')).toBeInTheDocument()
  })

  it('migrates legacy auto-open preferences to the minimized default', () => {
    window.localStorage.setItem('commando.pane-worklog.$1:%12', JSON.stringify({
      minimized: false,
      tasksCollapsed: true,
    }))

    render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    expect(screen.getByLabelText('Minimized worklog for Tests')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.queryByText('Map current behavior')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('commando.pane-worklog.$1:%12')).toContain('"visibilitySet":true')
  })

  it('shows the current plan and newest-first activity in its source pane', () => {
    render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))

    const worklog = screen.getByLabelText('Worklog for Tests')
    expect(worklog).toHaveTextContent('1/3')
    expect(worklog).toHaveTextContent('Map current behavior')
    expect(worklog).toHaveTextContent('Build pane-local UI')
    expect(worklog).toHaveTextContent('Discard old direction')
    expect(worklog).toHaveTextContent('Verify the running app')

    const events = screen.getByLabelText('Activity for Tests').querySelectorAll('.pane-worklog-event')
    expect(events[0]).toHaveTextContent('Keep it chat-like')
    expect(events[0]).toHaveTextContent('You')
    expect(events[0]).toHaveClass('is-user')
    expect(events[1]).toHaveTextContent('Use a pane-local split')
    expect(events[1]).not.toHaveClass('is-user')
    expect(events[2]).toHaveTextContent('Current flow mapped')
  })

  it('persists the minimized and plan-collapse controls per pane identity', () => {
    const view = render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))

    fireEvent.click(screen.getByRole('button', { name: 'Collapse plan for Tests' }))
    expect(screen.queryByText('Map current behavior')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Minimize worklog for Tests' }))
    expect(screen.getByLabelText('Minimized worklog for Tests')).toBeInTheDocument()
    expect(window.localStorage.getItem('commando.pane-worklog.$1:%12')).toContain('"minimized":true')

    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByLabelText('Worklog for Tests')).toBeInTheDocument()
    expect(screen.queryByText('Map current behavior')).not.toBeInTheDocument()

    view.unmount()
    render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    expect(screen.getByLabelText('Worklog for Tests')).toBeInTheDocument()
    expect(screen.queryByText('Map current behavior')).not.toBeInTheDocument()
  })

  it('autosaves a personal note and shows an indicator while minimized', () => {
    const view = render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'Note for Tests' }), {
      target: { value: 'Remember to check the release logs.' },
    })
    expect(window.localStorage.getItem('commando.pane-worklog.$1:%12')).toContain(
      'Remember to check the release logs.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Minimize worklog for Tests' }))
    expect(screen.getByTitle('Personal note saved')).toBeVisible()

    view.unmount()
    render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(screen.getByRole('textbox', { name: 'Note for Tests' })).toHaveValue(
      'Remember to check the release logs.',
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Note for Tests' }), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Minimize worklog for Tests' }))
    expect(screen.queryByTitle('Personal note saved')).not.toBeInTheDocument()
  })

  it('shows unseen screenshots on the rail and persists screenshot collapse and seen state', async () => {
    const screenshotBrief: SessionBrief = {
      ...brief,
      screenshots: [{
        id: '0123456789abcdef',
        dir: '/tmp/project/.screenshots/review',
        topic: 'review',
        imageCount: 25,
        otherCount: 1,
        bytes: 1_024,
        updatedAt: Date.now(),
        preview: [{ name: 'one.png', size: 100, modifiedAt: Date.now() }],
      }],
    }
    const screenshotsApi = { list: vi.fn().mockResolvedValue({ ...screenshotBrief.screenshots![0], files: screenshotBrief.screenshots![0].preview }) }
    render(<PaneWorklog brief={screenshotBrief} paneLabel="Tests" screenshotsApi={screenshotsApi} />)

    expect(screen.getByLabelText('25 unseen screenshots')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    expect(await screen.findByLabelText('Screenshots for pane %12')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse screenshots' }))
    const stored = window.localStorage.getItem('commando.pane-worklog.$1:%12') ?? ''
    expect(stored).toContain('"screenshotsCollapsed":true')
    expect(stored).toMatch(/"screenshotsSeenAt":\d+/)
  })

  it('opens screenshot events only when their exact folder id is still present', async () => {
    const folder = {
      id: '0123456789abcdef', dir: '/tmp/shots', topic: 'shots', imageCount: 1,
      otherCount: 0, bytes: 10, updatedAt: 100,
      preview: [{ name: 'one.png', size: 10, modifiedAt: 100 }],
    }
    const onOpenScreenshot = vi.fn()
    render(<PaneWorklog
      brief={{
        ...brief,
        screenshots: [folder],
        updates: [
          { id: 'current', paneId: '%12', kind: 'screenshots', screenshotFolderId: folder.id, text: 'Published shots', source: 'agent', createdAt: 100 },
          { id: 'evicted', paneId: '%12', kind: 'screenshots', screenshotFolderId: 'fedcba9876543210', text: 'Published old shots', source: 'agent', createdAt: 90 },
          { id: 'legacy', paneId: '%12', kind: 'screenshots', text: 'Published shots', detail: folder.dir, source: 'agent', createdAt: 80 },
        ],
      }}
      paneLabel="Tests"
      screenshotsApi={{ list: vi.fn().mockResolvedValue({ ...folder, files: folder.preview }) }}
      onOpenScreenshot={onOpenScreenshot}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))

    fireEvent.click(screen.getByRole('button', { name: /Published shots/ }))
    expect(onOpenScreenshot).toHaveBeenCalledWith(folder, undefined, expect.any(HTMLElement))
    expect(screen.getByText('Published old shots').closest('article')).not.toHaveAttribute('role')
    expect(screen.getAllByText('Published shots')[1].closest('article')).not.toHaveAttribute('role')
  })

  it('shows an open pull request indicator while minimized', async () => {
    const prsApi = { pane: vi.fn().mockResolvedValue({
      targetId: 'target', totalCount: 1, truncated: false, fetchedAt: Date.now(),
      pullRequests: [{
        repo: 'acme/app', number: 1, title: 'Open PR', url: 'https://example.test/pr/1',
        additions: 10, deletions: 2, checks: null, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
        state: 'open' as const, isDraft: false, createdAt: '2026-01-01', updatedAt: '2026-01-02',
      }],
    }) }
    render(<PaneWorklog brief={brief} paneLabel="Tests" prsApi={prsApi} />)
    expect(await screen.findByLabelText('Open pull request')).toBeInTheDocument()
  })

  it('keeps personal notes isolated by pane identity', () => {
    window.localStorage.setItem('commando.pane-worklog.$1:%12', JSON.stringify({
      minimized: false,
      tasksCollapsed: false,
      visibilitySet: true,
      note: 'First pane note',
    }))
    window.localStorage.setItem('commando.pane-worklog.$1:%13', JSON.stringify({
      minimized: false,
      tasksCollapsed: false,
      visibilitySet: true,
      note: 'Second pane note',
    }))
    const view = render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    expect(screen.getByRole('textbox', { name: 'Note for Tests' })).toHaveValue('First pane note')

    view.rerender(<PaneWorklog brief={{ ...brief, paneId: '%13' }} paneLabel="Worker" />)
    expect(screen.getByRole('textbox', { name: 'Note for Worker' })).toHaveValue('Second pane note')
  })

  it('follows newest-first activity from the top edge', () => {
    const view = render(<PaneWorklog brief={brief} paneLabel="Tests" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for Tests' }))
    const scroll = view.container.querySelector<HTMLElement>('.pane-worklog-scroll')!

    scroll.scrollTop = 120
    fireEvent.scroll(scroll)
    expect(screen.getByRole('button', { name: 'Follow live' })).toBeInTheDocument()

    view.rerender(<PaneWorklog
      brief={{
        ...brief,
        updates: [
          { id: 'latest', paneId: '%12', kind: 'note', text: 'Newest update', source: 'agent', createdAt: 40 },
          ...brief.updates,
        ],
      }}
      paneLabel="Tests"
    />)
    expect(screen.getByRole('button', { name: '1 new' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '1 new' }))
    expect(scroll.scrollTop).toBe(0)
    expect(screen.queryByRole('button', { name: 'Follow live' })).not.toBeInTheDocument()
  })
})
