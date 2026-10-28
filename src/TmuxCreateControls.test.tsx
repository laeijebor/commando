// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateTmuxSessionRequest, GitRepoInfo, TmuxCreatedTarget, TmuxCreateResponse } from '../shared/tmux-create'
import {
  START_WITH_STORAGE_KEY,
  TMUX_CWD_HISTORY_STORAGE_KEY,
  TmuxCreateControls,
  WORKTREE_PREPARE_COMMANDS_STORAGE_KEY,
} from './TmuxCreateControls'
import { agentPill, chooseAgent, choosePermission, expectAgent, menuLabels, openWorkspace, permissionPill } from './newSessionTestHelpers'

const created: TmuxCreatedTarget = {
  kind: 'session',
  sessionId: '$1',
  sessionName: 'work',
  windowId: '@2',
  windowIndex: 0,
  windowName: 'editor',
  paneId: '%3',
  paneIndex: 0,
  panePath: '/Users/dev/project',
}

const MAIN = '/Users/dev/gizmo/Save-All'
const repo: GitRepoInfo = { isRepo: true, root: MAIN, mainRoot: MAIN, name: 'Save-All', branch: 'main', isWorktree: false, defaultBranch: 'main', remote: 'origin' }
const notRepo: GitRepoInfo = { isRepo: false }

function probeFor(table: Record<string, GitRepoInfo>) {
  return vi.fn(async (directory: string): Promise<GitRepoInfo> => table[directory] ?? notRepo)
}

beforeEach(() => {
  // Most of these tests are about the session itself; start them on Nothing as before.
  window.localStorage.setItem(START_WITH_STORAGE_KEY, JSON.stringify({ '*': 'none' }))
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ command: '' })))
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  window.localStorage.clear()
})

describe('TmuxCreateControls', () => {
  it.each(['inline', 'dialog'] as const)('retains old-host partial creation in the %s form and opens it without a duplicate create', async (variant) => {
    const onCreateSession = vi.fn(async () => ({ created }))
    const onCreated = vi.fn()
    render(<TmuxCreateControls variant={variant} onCreateSession={onCreateSession} onCreated={onCreated} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    chooseAgent('cursor')
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('daemon did not confirm the requested Cursor interactive launch')
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create session' })).toBeDisabled()
    fireEvent.submit(screen.getByRole('button', { name: 'Create session' }).closest('form')!)
    expect(onCreateSession).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Open created session %3' }))
    expect(onCreated).toHaveBeenCalledWith(created, 'ungrouped', undefined)
    expect(onCreateSession).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('opens an old-host target once and creates a second Shell session in the same mounted inline form', async () => {
    const nextCreated = { ...created, sessionId: '$4', sessionName: 'next', paneId: '%5' }
    const onCreateSession = vi.fn().mockResolvedValueOnce({ created }).mockResolvedValueOnce({ created: nextCreated })
    let resolveOpen!: () => void
    const onCreated = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOpen = resolve }))
    render(<TmuxCreateControls onCreateSession={onCreateSession} onCreated={onCreated} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText(/Initial window name/), { target: { value: 'first-window' } })
    chooseAgent('cursor')
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: 'first prompt' } })
    const form = screen.getByRole('button', { name: 'Create session' }).closest('form')!
    fireEvent.submit(form)
    expect(await screen.findByRole('alert')).toHaveTextContent('daemon did not confirm the requested Cursor interactive launch')
    fireEvent.submit(form)
    expect(onCreateSession).toHaveBeenCalledOnce()

    const openButton = screen.getByRole('button', { name: 'Open created session %3' })
    fireEvent.click(openButton)
    fireEvent.click(openButton)
    fireEvent.submit(form)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created, 'ungrouped', undefined)
    expect(onCreateSession).toHaveBeenCalledOnce()
    expect(openButton).toBeDisabled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText('Session name')).toHaveValue('work')

    await act(async () => resolveOpen())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open created session %3' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Create session' }).closest('form')).toBe(form)
    expect(screen.getByLabelText('Session name')).toHaveValue('')
    expect(screen.getByLabelText(/Initial window name/)).toHaveValue('')
    expect(screen.getByLabelText(/Opening prompt/)).toHaveValue('')
    expectAgent('cursor')

    chooseAgent('shell')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'next' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreated).toHaveBeenLastCalledWith(nextCreated, 'ungrouped', undefined))
    expect(onCreateSession).toHaveBeenCalledTimes(2)
    expect(onCreateSession).toHaveBeenNthCalledWith(2, { name: 'next', windowName: '', cwd: '' })
    expect(onCreated).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('Created session %5 in next')
  })

  it('retains the partial target and creation guard when opening fails, then resets only after a successful retry', async () => {
    const onCreateSession = vi.fn(async () => ({ created }))
    const onCreated = vi.fn().mockRejectedValueOnce(new Error('Unable to open session')).mockResolvedValueOnce(undefined)
    render(<TmuxCreateControls onCreateSession={onCreateSession} onCreated={onCreated} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    chooseAgent('cursor')
    const form = screen.getByRole('button', { name: 'Create session' }).closest('form')!
    fireEvent.submit(form)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Open created session %3' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to open session'))
    expect(screen.getByLabelText('Session name')).toHaveValue('work')
    expect(screen.getByRole('button', { name: 'Create session' })).toBeDisabled()
    fireEvent.submit(form)
    expect(onCreateSession).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Open created session %3' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled()
    expect(onCreateSession).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledTimes(2)
  })

  it('allows the dialog parent to close immediately when the preserved target is opened', async () => {
    const onCreateSession = vi.fn(async () => ({ created }))
    const onCreated = vi.fn((): void => view.unmount())
    const view = render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} onCreated={onCreated} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    chooseAgent('cursor')
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await screen.findByRole('alert')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open created session %3' })))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created, 'ungrouped', undefined)
    expect(onCreateSession).toHaveBeenCalledOnce()
    expect(view.container).toBeEmptyDOMElement()
  })
  it.each(['inline', 'dialog'] as const)('creates Cursor interactively in the %s form with None as the default', async (variant) => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, ...(input.agent ? { agentLaunch: { version: 1, provider: input.agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } } : {}) }))
    render(<TmuxCreateControls variant={variant} onCreateSession={onCreateSession} />)
    expectAgent('none')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    chooseAgent('cursor')
    const prompt = "Read Leo's spec\nInspect $HOME `whoami`"
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: prompt } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith({ name: 'work', windowName: '', cwd: '', agent: { provider: 'cursor', prompt } }))
    expectAgent('cursor')
    await waitFor(() => expect(screen.getByLabelText(/Opening prompt/)).toHaveValue(''))
  })

  it('starts a quick Claude chat when nothing has been remembered yet', () => {
    window.localStorage.clear()
    render(<TmuxCreateControls variant="dialog" onCreateSession={vi.fn()} />)
    expectAgent('claude-chat')
    expect(screen.getByLabelText('Opening prompt')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeInTheDocument()
  })

  it('remembers what each repository starts with, and elsewhere what was started last', async () => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, ...(input.agent ? { agentLaunch: { version: 1, provider: input.agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } } : {}) }))
    const probe = probeFor({ [MAIN]: repo })
    const view = render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} probeRepo={probe} />)
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await screen.findByLabelText(/Create a worktree and branch/)
    expectAgent('none')
    chooseAgent('codex')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ agent: { provider: 'codex' } })))
    expect(JSON.parse(window.localStorage.getItem(START_WITH_STORAGE_KEY)!)).toEqual({ [MAIN]: 'codex', '*': 'codex' })
    window.localStorage.setItem(START_WITH_STORAGE_KEY, JSON.stringify({ [MAIN]: 'codex', '*': 'shell' }))

    view.unmount()
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} probeRepo={probe} />)
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await waitFor(() => expectAgent('codex'))
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/Users/dev/other' } })
    await waitFor(() => expectAgent('shell'))
  })

  it('picks up a choice remembered elsewhere each time the inline form opens', async () => {
    render(<TmuxCreateControls onCreateSession={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/Users/dev/plain' } })
    expectAgent('none')
    window.localStorage.setItem(START_WITH_STORAGE_KEY, JSON.stringify({ '/Users/dev/plain': 'opencode' }))
    const details = screen.getByText('New session').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    expectAgent('opencode')
  })

  it('omits a retained opening prompt when switching to OpenCode or Shell', async () => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, ...(input.agent ? { agentLaunch: { version: 1, provider: input.agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } } : {}) }))
    render(<TmuxCreateControls onCreateSession={onCreateSession} />)
    chooseAgent('cursor')
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: 'Read' } })
    chooseAgent('opencode')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ agent: { provider: 'opencode' } })))
    chooseAgent('shell')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenLastCalledWith({ name: 'work', windowName: '', cwd: '' }))
  })
  it('submits session fields and exposes pending and success states', async () => {
    let resolveCreate: ((value: TmuxCreateResponse) => void) | undefined
    const onCreateSession = vi.fn(
      () =>
        new Promise<TmuxCreateResponse>((resolve) => {
          resolveCreate = resolve
        }),
    )
    const onCreated = vi.fn()
    render(<TmuxCreateControls onCreateSession={onCreateSession} onCreated={onCreated} />)

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText(/Initial window name/), {
      target: { value: 'editor' },
    })
    fireEvent.change(screen.getByLabelText(/Working directory/), {
      target: { value: '/Users/dev/project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    expect(onCreateSession).toHaveBeenCalledWith({
      name: 'work',
      windowName: 'editor',
      cwd: '/Users/dev/project',
      empty: true,
    })
    expect(screen.getByRole('button', { name: 'Creating...' })).toHaveProperty(
      'disabled',
      true,
    )

    resolveCreate?.({ created })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Created session %3 in work',
    )
    expect(onCreated).toHaveBeenCalledWith(created, 'ungrouped', undefined)
    expect(JSON.parse(window.localStorage.getItem(TMUX_CWD_HISTORY_STORAGE_KEY) ?? 'null')).toEqual([
      '/Users/dev/project',
    ])
    expect(screen.getByLabelText(/Working directory/)).toHaveValue('/Users/dev/project')
  })

  it('only offers sessions: there are no window or split modes', () => {
    render(<TmuxCreateControls onCreateSession={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Window' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Split' })).not.toBeInTheDocument()
    expect(screen.getByText('New session')).toBeInTheDocument()
  })

  it('restores the last successfully used working directory', () => {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, '/Users/dev/remembered')

    render(<TmuxCreateControls onCreateSession={vi.fn()} />)

    expect(screen.getByLabelText(/Working directory/)).toHaveValue('/Users/dev/remembered')
  })

  it('filters recent directories and supports mouse and keyboard selection', () => {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, JSON.stringify([
      '/Users/dev/bravo',
      '/tmp/project',
      '/Users/dev/beta',
    ]))

    render(<TmuxCreateControls onCreateSession={vi.fn()} />)

    openWorkspace()
    const input = screen.getByRole('combobox', { name: /Working directory/ })
    fireEvent.focus(input)
    expect(screen.getByRole('listbox', { name: 'Suggested working directories' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '/tmp/project' })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '/tmp' } })
    expect(screen.queryByRole('option', { name: '/Users/dev/bravo' })).not.toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('option', { name: '/tmp/project' }))
    expect(input).toHaveValue('/tmp/project')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '/Users/dev/b' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('/Users/dev/beta')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('keeps successful directories in bounded most-recently-used order', async () => {
    const existing = Array.from({ length: 10 }, (_, index) => `/Users/dev/project-${index}`)
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, JSON.stringify(existing))
    render(<TmuxCreateControls onCreateSession={vi.fn(async () => ({ created }))} />)

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), {
      target: { value: '/Users/dev/new-project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    await screen.findByRole('status')
    const history = JSON.parse(window.localStorage.getItem(TMUX_CWD_HISTORY_STORAGE_KEY) ?? 'null')
    expect(history).toHaveLength(10)
    expect(history).toEqual(['/Users/dev/new-project', ...existing.slice(0, 9)])
  })

  it('moves a reused directory to the front without duplicating it', async () => {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, JSON.stringify([
      '/Users/dev/alpha',
      '/Users/dev/beta',
      '/Users/dev/charlie',
    ]))
    render(<TmuxCreateControls onCreateSession={vi.fn(async () => ({ created }))} />)

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), {
      target: { value: '/Users/dev/beta' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    await screen.findByRole('status')
    expect(JSON.parse(window.localStorage.getItem(TMUX_CWD_HISTORY_STORAGE_KEY) ?? 'null')).toEqual([
      '/Users/dev/beta',
      '/Users/dev/alpha',
      '/Users/dev/charlie',
    ])
  })

  it('renders callback failures as an alert and restores the submit action', async () => {
    render(
      <TmuxCreateControls
        onCreateSession={vi.fn(async () => {
          throw new Error('session already exists')
        })}
      />,
    )

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), {
      target: { value: '/Users/dev/not-created' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('session already exists')
    expect(window.localStorage.getItem(TMUX_CWD_HISTORY_STORAGE_KEY)).toBeNull()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create session' })).toHaveProperty(
        'disabled',
        false,
      )
    })
  })

  it('opens in a requested group and prioritizes that group directory', async () => {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, JSON.stringify(['/Users/dev/recent']))
    const onCreated = vi.fn()
    render(
      <TmuxCreateControls
        sessionCreateRequest={{
          id: 1,
          groupId: 'gizmo',
          groupName: 'GIZMO',
          suggestedDirectories: ['/Users/dev/gizmo', '/Users/dev/shared'],
        }}
        onCreateSession={vi.fn(async () => ({ created }))}
        onCreated={onCreated}
      />,
    )

    expect(await screen.findByText('New session in GIZMO')).toBeVisible()
    expect(screen.getByText('GIZMO', { selector: '.tmux-create__destination strong' })).toBeVisible()
    expect(screen.getByLabelText('Session name')).toHaveFocus()
    openWorkspace()
    const directory = screen.getByRole('combobox', { name: /Working directory/ })
    expect(directory).toHaveValue('/Users/dev/gizmo')
    fireEvent.focus(directory)
    expect(within(screen.getByRole('listbox', { name: 'Suggested working directories' })).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '/Users/dev/gizmo',
      '/Users/dev/shared',
      '/Users/dev/recent',
    ])

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'new-gizmo-session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created, 'gizmo', undefined))
  })
})

describe('TmuxCreateControls worktrees', () => {
  it('offers a worktree once the working directory resolves to a repository, with the branch following the name', async () => {
    const probeRepo = probeFor({ [MAIN]: repo })
    render(<TmuxCreateControls onCreateSession={vi.fn()} probeRepo={probeRepo} />)

    expect(screen.queryByLabelText(/Create a worktree/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    const toggle = await screen.findByLabelText(/Create a worktree and branch/)
    expect(toggle).toBeChecked()
    expect(probeRepo).toHaveBeenCalledWith(MAIN)

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Bot rematch flow' } })
    expect(screen.getByLabelText(/^Branch/)).toHaveValue('bot-rematch-flow')
    expect(screen.getByText(`${MAIN}-worktrees/bot-rematch-flow`)).toBeInTheDocument()
    expect(screen.getByText('origin/main')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^Branch/), { target: { value: 'custom-branch' } })
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Renamed' } })
    expect(screen.getByLabelText(/^Branch/)).toHaveValue('custom-branch')
  })

  it('sends the worktree with the request and reports where the session opened', async () => {
    const onCreateSession = vi.fn(async (): Promise<TmuxCreateResponse> => ({
      created: { ...created, panePath: `${MAIN}-worktrees/bot-rematch-flow` },
      worktree: { path: `${MAIN}-worktrees/bot-rematch-flow`, branch: 'bot-rematch-flow', base: 'origin/main', reusedBranch: false, warning: 'Could not fetch origin/main (offline); branched from the local copy of origin/main instead' },
    }))
    const onCreated = vi.fn()
    render(<TmuxCreateControls onCreateSession={onCreateSession} onCreated={onCreated} probeRepo={probeFor({ [MAIN]: repo })} />)

    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await screen.findByLabelText(/Create a worktree and branch/)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Bot rematch flow' } })
    fireEvent.change(screen.getByLabelText(/^Prepare worktree/), { target: { value: 'pnpm i\npnpm build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith({
      name: 'Bot rematch flow',
      windowName: '',
      cwd: MAIN,
      worktree: { branch: 'bot-rematch-flow', prepareCommand: 'pnpm i\npnpm build' },
      empty: true,
    }))
    expect(await screen.findByRole('status')).toHaveTextContent(`bot-rematch-flow`)
    expect(screen.getByRole('status')).toHaveTextContent(/Preparation started/)
    expect(screen.getByRole('status')).toHaveTextContent(/Could not fetch/)
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session' }), 'ungrouped', expect.objectContaining({ branch: 'bot-rematch-flow' }))
  })

  it('persists and pre-fills preparation commands by the main repository root', async () => {
    window.localStorage.setItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY, JSON.stringify({
      [MAIN]: 'pnpm i',
      '/Users/dev/other': 'npm ci',
    }))
    render(
      <TmuxCreateControls
        sessionCreateRequest={{ id: 1, groupId: `repo:${MAIN}`, groupName: 'Save-All', suggestedDirectories: [MAIN], repo: { root: MAIN, name: 'Save-All', defaultBranch: 'main' } }}
        onCreateSession={vi.fn()}
        probeRepo={probeFor({ [MAIN]: repo })}
      />,
    )

    const command = await screen.findByLabelText(/^Prepare worktree/)
    expect(command).toHaveValue('pnpm i')
    expect(screen.getByText(/saved for Save-All/)).toBeInTheDocument()

    fireEvent.change(command, { target: { value: 'pnpm install\npnpm build' } })
    expect(JSON.parse(window.localStorage.getItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY) ?? 'null')).toEqual({
      [MAIN]: 'pnpm install\npnpm build',
      '/Users/dev/other': 'npm ci',
    })

    fireEvent.change(command, { target: { value: '' } })
    expect(JSON.parse(window.localStorage.getItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY) ?? 'null')).toEqual({
      '/Users/dev/other': 'npm ci',
    })
  })

  it('can skip a saved preparation command for one session without clearing it', async () => {
    window.localStorage.setItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY, JSON.stringify({ [MAIN]: 'pnpm i' }))
    const onCreateSession = vi.fn(async (): Promise<TmuxCreateResponse> => ({
      created: { ...created, panePath: `${MAIN}-worktrees/quick-session` },
      worktree: { path: `${MAIN}-worktrees/quick-session`, branch: 'quick-session', base: 'origin/main', reusedBranch: false },
    }))
    render(<TmuxCreateControls onCreateSession={onCreateSession} probeRepo={probeFor({ [MAIN]: repo })} />)

    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    const runPreparation = await screen.findByLabelText('Run preparation command for this session')
    expect(runPreparation).toBeChecked()
    await waitFor(() => expect(screen.getByLabelText(/^Prepare worktree/)).toHaveValue('pnpm i'))

    fireEvent.click(runPreparation)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Quick session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith({
      name: 'Quick session',
      windowName: '',
      cwd: MAIN,
      worktree: { branch: 'quick-session' },
      empty: true,
    }))
    expect(await screen.findByRole('status')).not.toHaveTextContent(/Preparation started/)
    expect(JSON.parse(window.localStorage.getItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY) ?? 'null')).toEqual({ [MAIN]: 'pnpm i' })
    expect(runPreparation).toBeChecked()
  })

  it('sends an edited worktree path and omits the worktree when the toggle is off', async () => {
    const onCreateSession = vi.fn(async () => ({ created }))
    render(<TmuxCreateControls onCreateSession={onCreateSession} probeRepo={probeFor({ [MAIN]: repo })} />)
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    const toggle = await screen.findByLabelText(/Create a worktree and branch/)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'flow' } })

    openWorkspace()
    fireEvent.click(screen.getByRole('button', { name: /Edit worktree path/ }))
    fireEvent.change(screen.getByLabelText(/Worktree path/), { target: { value: '/Users/dev/elsewhere/flow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenLastCalledWith(expect.objectContaining({
      worktree: { branch: 'flow', path: '/Users/dev/elsewhere/flow' },
    })))

    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'plain' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenLastCalledWith({ name: 'plain', windowName: '', cwd: MAIN, empty: true }))
  })

  it('warns instead of offering a worktree when the directory is not a repository', async () => {
    render(<TmuxCreateControls onCreateSession={vi.fn(async () => ({ created }))} probeRepo={probeFor({})} />)
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/Users/dev/plain' } })
    expect(await screen.findByText(/Not a git repository/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Create a worktree/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled()
  })

  it('pre-fills the main checkout and shows the repository when opened from a repository group', async () => {
    render(
      <TmuxCreateControls
        sessionCreateRequest={{ id: 1, groupId: `repo:${MAIN}`, groupName: 'Save-All', suggestedDirectories: [MAIN], repo: { root: MAIN, name: 'Save-All', defaultBranch: 'main' } }}
        onCreateSession={vi.fn()}
        probeRepo={probeFor({ [MAIN]: repo })}
      />,
    )
    expect(screen.getByText('Save-All', { selector: '.tmux-create__destination strong' })).toBeVisible()
    expect(screen.getByText(/^Repository/)).toBeInTheDocument()
    openWorkspace()
    expect(screen.getByRole('combobox', { name: /Working directory/ })).toHaveValue(MAIN)
    expect(await screen.findByLabelText(/Create a worktree and branch/)).toBeChecked()
  })

  it('shows a known repository immediately while its real probe is pending', () => {
    const probeRepo = vi.fn(() => new Promise<GitRepoInfo>(() => undefined))
    render(
      <TmuxCreateControls
        sessionCreateRequest={{ id: 1, groupId: `repo:${MAIN}`, groupName: 'Save-All', suggestedDirectories: [MAIN], repo: { root: MAIN, name: 'Save-All', defaultBranch: 'main' } }}
        onCreateSession={vi.fn()}
        probeRepo={probeRepo}
      />,
    )

    expect(screen.getByLabelText(/Create a worktree and branch/)).toBeChecked()
    expect(screen.getByText('origin/main')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled()
  })

  it('disables submit and reports while the current directory is being probed', () => {
    const probeRepo = vi.fn(() => new Promise<GitRepoInfo>(() => undefined))
    render(<TmuxCreateControls onCreateSession={vi.fn()} probeRepo={probeRepo} />)

    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })

    expect(screen.getByRole('button', { name: 'Checking repository...' })).toBeDisabled()
  })

  it('releases an unknown directory when its repository probe never responds', async () => {
    vi.useFakeTimers()
    try {
      const probeRepo = vi.fn(() => new Promise<GitRepoInfo>(() => undefined))
      render(<TmuxCreateControls onCreateSession={vi.fn()} probeRepo={probeRepo} />)

      fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
      expect(screen.getByRole('button', { name: 'Checking repository...' })).toBeDisabled()
      await act(async () => { vi.advanceTimersByTime(10_200) })

      expect(probeRepo).toHaveBeenCalledWith(MAIN)
      expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled()
      expect(screen.getByText(/Repository check timed out/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the current probe when a parent supplies a new callback during a render', async () => {
    let resolveProbe: ((info: GitRepoInfo) => void) | undefined
    const firstProbe = vi.fn(() => new Promise<GitRepoInfo>((resolve) => { resolveProbe = resolve }))
    const secondProbe = vi.fn(async () => repo)
    const request = { id: 1, groupId: `repo:${MAIN}`, groupName: 'Save-All', suggestedDirectories: [MAIN], repo: { root: MAIN, name: 'Save-All', defaultBranch: 'main' } }
    const onCreateSession = vi.fn(async (): Promise<TmuxCreateResponse> => ({ created }))
    const { rerender } = render(<TmuxCreateControls sessionCreateRequest={request} onCreateSession={onCreateSession} probeRepo={firstProbe} />)

    await waitFor(() => expect(firstProbe).toHaveBeenCalledWith(MAIN))
    rerender(<TmuxCreateControls sessionCreateRequest={request} onCreateSession={onCreateSession} probeRepo={secondProbe} />)
    resolveProbe?.(repo)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create session' })).toBeEnabled())
    expect(secondProbe).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'new-session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: MAIN,
      worktree: { branch: 'new-session' },
    })))
  })

  it('renders as an always-open panel in dialog mode', () => {
    render(<TmuxCreateControls variant="dialog" onCreateSession={vi.fn()} />)
    expect(screen.queryByText('New session', { selector: 'summary' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Session name')).toBeInTheDocument()
  })
})

describe('Claude chat launches', () => {
  const profiles = [
    { name: 'claude', configDir: '/Users/dev/.claude', lastUsedAt: 1 },
    { name: 'claudep', configDir: '/Users/dev/.claudep', lastUsedAt: 30 },
    { name: 'claudew', configDir: '/Users/dev/.claudew', lastUsedAt: 20 },
  ]
  const chatResponse = (input: CreateTmuxSessionRequest): TmuxCreateResponse => ({
    created,
    agentLaunch: { version: 1, provider: input.agent!.provider, paneId: '%3', mode: 'interactive-pty', state: 'initiated' },
  })

  it('lists each Claude profile for chat and terminal, chats first, and remembers the pick per repository', async () => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest) => chatResponse(input))
    const probe = probeFor({ [MAIN]: repo })
    const view = render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} probeRepo={probe} loadClaudeProfiles={async () => profiles} />)
    await waitFor(() => expect(menuLabels(agentPill())).toContain('Claude chat · claudew'))
    const labels = menuLabels(agentPill())
    expect(labels.slice(0, 3)).toEqual(['Claude chat · claude', 'Claude chat · claudep', 'Claude chat · claudew'])
    expect(labels.indexOf('Cursor chat')).toBeLessThan(labels.indexOf('Claude terminal · claude'))
    expect(labels).toEqual(expect.arrayContaining(['Claude terminal · claudep', 'Claude terminal · claudew', 'Shell', '*Nothing']))

    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await screen.findByLabelText(/Create a worktree and branch/)
    chooseAgent('claude-chat', 'claudew')
    expectAgent('claude-chat', 'claudew')
    choosePermission('Accept edits')
    fireEvent.click(await screen.findByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0].agent).toEqual({ provider: 'claude-chat', configDir: '/Users/dev/.claudew', permissionMode: 'acceptEdits' })

    view.unmount()
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} probeRepo={probe} loadClaudeProfiles={async () => profiles} />)
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await waitFor(() => expectAgent('claude-chat', 'claudew'))
    expect(permissionPill()).toHaveAccessibleName('Permissions: Accept edits')
  })

  it('starts terminal Claude on the chosen profile, with no permission mode', async () => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest) => chatResponse(input))
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} loadClaudeProfiles={async () => profiles} />)
    await waitFor(() => expect(menuLabels(agentPill())).toContain('Claude terminal · claudep'))
    chooseAgent('claude', 'claudep')
    expect(screen.queryByRole('button', { name: /^Permissions:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Attach images or videos' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Opening prompt'), { target: { value: 'Fix it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0]).toMatchObject({ name: '', autoName: true, agent: { provider: 'claude', configDir: '/Users/dev/.claudep', prompt: 'Fix it' } })
  })

  it('names profiles by their Settings label and starts on the chosen default', async () => {
    window.localStorage.clear()
    const labelled = [profiles[0]!, { ...profiles[1]!, label: 'Personal' }, { ...profiles[2]!, label: 'Work', isDefault: true }]
    render(<TmuxCreateControls variant="dialog" onCreateSession={vi.fn()} probeRepo={probeFor({ [MAIN]: repo })} loadClaudeProfiles={async () => labelled} />)
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await screen.findByLabelText(/Create a worktree and branch/)
    await waitFor(() => expectAgent('claude-chat', 'Work'))
    expect(menuLabels(agentPill()).slice(0, 3)).toEqual(['Claude chat · claude', 'Claude chat · Personal', '*Claude chat · Work'])
  })
})

describe('models', () => {
  const claudeModels = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5' },
    { value: 'sonnet', displayName: 'Sonnet 5.5' },
  ]
  const catalogs = {
    'claude:/Users/dev/.claudep': { models: claudeModels, updatedAt: Date.now() - 2 * 3_600_000 },
    codex: { models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }, { value: 'gpt-6-luna', displayName: 'GPT-6-Luna' }], updatedAt: 1 },
  }
  const respond = async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, agentLaunch: { version: 1, provider: input.agent!.provider, paneId: '%3', mode: 'interactive-pty', state: 'initiated' } })

  it("offers the cached models for the agent and profile, starts on the pick and remembers it", async () => {
    window.localStorage.clear()
    window.localStorage.setItem('commando.chat-launch.by-repo', JSON.stringify({ '*': { configDir: '/Users/dev/.claudep', permissionMode: 'default' } }))
    const onCreateSession = vi.fn(respond)
    const view = render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} loadModelCatalogs={async () => catalogs} />)
    const pill = await screen.findByRole('button', { name: 'Model: Default model' })
    fireEvent.click(pill)
    expect(screen.getByText(/From this agent's last chat, 2h ago/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ }))
    expect(screen.getByRole('button', { name: 'Model: Sonnet 5.5' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0].agent).toMatchObject({ provider: 'claude-chat', model: 'sonnet' })

    view.unmount()
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} loadModelCatalogs={async () => catalogs} />)
    expect(await screen.findByRole('button', { name: 'Model: Sonnet 5.5' })).toBeInTheDocument()
    // A pick in one folder doesn't follow the form to another that remembers its own.
    window.localStorage.setItem('commando.tmux-create.model-by-agent', JSON.stringify({ '*|claude:/Users/dev/.claudep': 'sonnet', '/Users/dev/other|claude:/Users/dev/.claudep': 'default' }))
    fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet 5.5' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ }))
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/Users/dev/other' } })
    expect(await screen.findByRole('button', { name: 'Model: Default model' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '' } })
    chooseAgent('codex-chat')
    // Codex has no "default" entry of its own: the picker adds one, which sends no model.
    expect(menuLabels(screen.getByRole('button', { name: 'Model: Default model' }))).toEqual(['*Default', 'GPT-6.1-Sol', 'GPT-6-Luna'])
    chooseAgent('shell')
    expect(screen.queryByRole('button', { name: /^Model:/ })).not.toBeInTheDocument()
  })
})

describe('opening prompt first', () => {
  const respond = async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, agentLaunch: { version: 1, provider: input.agent!.provider, paneId: '%3', mode: 'interactive-pty', state: 'initiated' } })
  const png = () => new File(['png'], 'shot.png', { type: 'image/png' })

  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: () => {} })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends a pasted screenshot with the prompt, and lets the daemon name the session', async () => {
    const onCreateSession = vi.fn(respond)
    let finish!: (ref: { id: string; name: string }) => void
    const uploadImage = vi.fn(() => new Promise<{ id: string; name: string }>((resolve) => { finish = resolve }))
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} uploads={{ uploadImage, uploadVideo: vi.fn() }} />)
    const prompt = screen.getByLabelText('Opening prompt')
    expect(screen.getByLabelText('Session name')).toBeRequired()
    fireEvent.paste(prompt, { clipboardData: { files: [png()] } })
    await waitFor(() => expect(uploadImage).toHaveBeenCalledOnce())
    expect(screen.getByLabelText('Session name')).not.toBeRequired()
    expect(screen.getByLabelText('Session name')).toHaveAttribute('placeholder', 'Named from the prompt')
    expect(screen.getByRole('button', { name: 'Uploading images...' })).toBeDisabled()
    await act(async () => finish({ id: `${'a'.repeat(64)}.png`, name: 'shot.png' }))
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0]).toEqual({
      name: '', autoName: true, windowName: '', cwd: '',
      agent: { provider: 'claude-chat', images: [{ id: `${'a'.repeat(64)}.png`, name: 'shot.png' }], permissionMode: 'default' },
    })
  })

  it('asks the naming model for a name, says so on the button, and lets ⌘↵ skip the wait', async () => {
    const onCreateSession = vi.fn(respond)
    let answer!: (value: { name: string | null; by?: string }) => void
    const suggest = vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<{ name: string | null; by?: string }>((resolve, reject) => {
      answer = resolve
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const describe = vi.fn(async () => ({ settings: { mode: 'naming-model' as const, namingModel: { provider: 'codex' as const, model: 'gpt-6-luna' }, timeoutSeconds: 10 }, status: { state: 'available' as const }, label: 'GPT-6-Luna' }))
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} naming={{ suggest, describe }} />)
    const prompt = screen.getByLabelText('Opening prompt')
    fireEvent.change(prompt, { target: { value: 'Tidy the README' } })
    await waitFor(() => expect(screen.getByLabelText('Session name')).toHaveAttribute('placeholder', 'Auto · named by GPT-6-Luna'))
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    expect(await screen.findByRole('button', { name: 'Naming with GPT-6-Luna...' })).toBeEnabled()
    expect(suggest).toHaveBeenCalledWith({ prompt: 'Tidy the README', chat: { provider: 'claude' } }, expect.any(AbortSignal))
    await act(async () => answer({ name: 'tidy-readme', by: 'GPT-6-Luna' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0]).toMatchObject({ name: 'tidy-readme', autoName: true })

    fireEvent.change(prompt, { target: { value: 'Another one' } })
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    await screen.findByRole('button', { name: 'Naming with GPT-6-Luna...' })
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(2))
    expect(onCreateSession.mock.calls[1]![0]).toMatchObject({ name: '', autoName: true })
  })

  it('creates nothing when the dialog closes while the model names the session', async () => {
    const onCreateSession = vi.fn(respond)
    let answer!: (value: { name: string | null }) => void
    const suggest = vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<{ name: string | null }>((resolve, reject) => {
      answer = resolve
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const view = render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} naming={{ suggest, describe: vi.fn(async () => { throw new Error('offline') }) }} uploads={{ uploadImage: vi.fn(async () => ({ id: `${'c'.repeat(64)}.png` })), uploadVideo: vi.fn() }} />)
    const prompt = screen.getByLabelText('Opening prompt')
    fireEvent.change(prompt, { target: { value: 'Go' } })
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    await screen.findByRole('button', { name: /^Naming with/ })
    // A paste mid-naming would be left out of the session, so it is ignored.
    fireEvent.paste(prompt, { clipboardData: { files: [png()] } })
    expect(screen.queryByRole('button', { name: 'Open shot.png' })).not.toBeInTheDocument()
    view.unmount()
    await act(async () => { answer({ name: 'late' }) })
    expect(suggest.mock.calls[0]![1]!.aborted).toBe(true)
    expect(onCreateSession).not.toHaveBeenCalled()
  })

  it("names with the chat's model when the naming model can't work here", async () => {
    const describe = vi.fn(async () => ({ settings: { mode: 'naming-model' as const, namingModel: { provider: 'codex' as const, model: 'gpt-6-luna' }, timeoutSeconds: 10 }, status: { state: 'unavailable' as const, since: 1, reason: 'Not logged in', canRetry: true }, label: 'GPT-6-Luna' }))
    render(<TmuxCreateControls variant="dialog" onCreateSession={vi.fn(respond)} naming={{ suggest: vi.fn(), describe }} />)
    fireEvent.change(screen.getByLabelText('Opening prompt'), { target: { value: 'Go' } })
    await waitFor(() => expect(screen.getByLabelText('Session name')).toHaveAttribute('placeholder', 'Auto · named by Claude'))
  })

  it('needs a name for agents without a prompt, and keeps images away from non-chats', async () => {
    render(<TmuxCreateControls variant="dialog" onCreateSession={vi.fn(respond)} uploads={{ uploadImage: vi.fn(async () => ({ id: `${'b'.repeat(64)}.png` })), uploadVideo: vi.fn() }} />)
    fireEvent.paste(screen.getByLabelText('Opening prompt'), { clipboardData: { files: [png()] } })
    await screen.findByRole('button', { name: 'Open shot.png' })
    chooseAgent('codex')
    expect(screen.getByText(/Only chats are sent images/)).toBeInTheDocument()
    chooseAgent('shell')
    expect(screen.queryByLabelText('Opening prompt')).not.toBeInTheDocument()
    expect(screen.getByText('A shell starts without an opening prompt.')).toBeInTheDocument()
    expect(screen.getByLabelText('Session name')).toBeRequired()
  })

  it('ignores ⌘↵ while the button is disabled: no double launch, no launch before the repository is known', async () => {
    let finish!: (value: TmuxCreateResponse) => void
    const onCreateSession = vi.fn(() => new Promise<TmuxCreateResponse>((resolve) => { finish = resolve }))
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} probeRepo={() => new Promise(() => {})} />)
    const prompt = screen.getByLabelText('Opening prompt')
    fireEvent.change(prompt, { target: { value: 'Go' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await screen.findByRole('button', { name: 'Checking repository...' })
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    expect(onCreateSession).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '' } })
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    fireEvent.keyDown(screen.getByLabelText('Session name'), { key: 'Enter', metaKey: true })
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true, repeat: true })
    expect(onCreateSession).toHaveBeenCalledOnce()
    await act(async () => finish({ created, agentLaunch: { version: 1, provider: 'claude-chat', paneId: '%3', mode: 'interactive-pty', state: 'initiated' } }))
  })

  it('keeps a remembered model while its list is unknown, and never overwrites it with the default', async () => {
    window.localStorage.setItem('commando.tmux-create.model-by-agent', JSON.stringify({ '*|claude': 'opus' }))
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, agentLaunch: { version: 1, provider: input.agent!.provider, paneId: '%3', mode: 'interactive-pty', state: 'initiated' } }))
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} loadModelCatalogs={async () => { throw new Error('offline') }} />)
    expect(await screen.findByRole('button', { name: 'Model: opus' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Opening prompt'), { target: { value: 'Go' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0].agent).toMatchObject({ model: 'opus' })
    expect(JSON.parse(window.localStorage.getItem('commando.tmux-create.model-by-agent')!)).toEqual({ '*|claude': 'opus' })
  })

  it('keeps the workspace folded until something needs attention', async () => {
    render(<TmuxCreateControls variant="dialog" onCreateSession={vi.fn()} probeRepo={probeFor({ [MAIN]: repo })} />)
    const summary = () => screen.getByRole('button', { expanded: false, name: /folder|worktree|repo/ })
    expect(summary()).toHaveTextContent('In the default folder')
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: MAIN } })
    await waitFor(() => expect(summary()).toHaveTextContent('New worktree named after the session · origin/main'))
    fireEvent.change(screen.getByLabelText('Opening prompt'), { target: { value: 'Tidy the README' } })
    expect(summary()).toHaveTextContent('New worktree named from the prompt · origin/main')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Quick chat' } })
    expect(summary()).toHaveTextContent('New worktree quick-chat · origin/main')
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/Users/dev/scratch' } })
    const opened = await screen.findByRole('button', { expanded: true })
    expect(opened).toHaveTextContent('In ~/scratch · not a git repo')
    expect(screen.getByText(/Not a git repository/)).toBeVisible()
  })
})

describe('Claude chat profile loading', () => {
  it('keeps the remembered profile when the profile list cannot be loaded', async () => {
    window.localStorage.setItem('commando.chat-launch.by-repo', JSON.stringify({ '*': { configDir: '/Users/dev/.claudew', permissionMode: 'plan' } }))
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({
      created, agentLaunch: { version: 1, provider: input.agent!.provider, paneId: '%3', mode: 'interactive-pty', state: 'initiated' },
    }))
    render(<TmuxCreateControls variant="dialog" onCreateSession={onCreateSession} loadClaudeProfiles={async () => { throw new Error('offline') }} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    chooseAgent('claude-chat')
    const submit = screen.getByRole('button', { name: 'Start chat' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0].agent).toEqual({ provider: 'claude-chat', configDir: '/Users/dev/.claudew', permissionMode: 'plan' })
    expect(JSON.parse(window.localStorage.getItem('commando.chat-launch.by-repo')!)['*']).toEqual({ configDir: '/Users/dev/.claudew', permissionMode: 'plan' })
  })
})

describe('prepare-command daemon sync', () => {
  const request = { id: 1, groupId: 'repo', groupName: 'Repo', suggestedDirectories: [MAIN], repo: { root: MAIN, name: 'Save-All' } }
  it('prefills a missing local value with an authenticated owner GET and syncs it on creation', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ command: 'npm ci' })))
    const onCreateSession = vi.fn().mockResolvedValue({ created })
    render(<TmuxCreateControls token="owner" variant="dialog" sessionCreateRequest={request} onCreateSession={onCreateSession} />)
    const prepare = await screen.findByLabelText(/^Prepare worktree/)
    await waitFor(() => expect(prepare).toHaveValue('npm ci'))
    expect(fetch).toHaveBeenCalledWith(`/api/repo-prepare-commands?root=${encodeURIComponent(MAIN)}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', headers: expect.objectContaining({ Authorization: 'Bearer owner' }) }))
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'next' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/api/repo-prepare-commands', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ root: MAIN, command: 'npm ci' }) }))
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ worktree: expect.objectContaining({ prepareCommand: 'npm ci' }) }))
  })
  it('prefers localStorage, PUTs edits against the main root, and sends empty to delete', async () => {
    window.localStorage.setItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY, JSON.stringify({ [MAIN]: 'pnpm i' }))
    render(<TmuxCreateControls token="owner" variant="dialog" sessionCreateRequest={request} onCreateSession={vi.fn()} />)
    const prepare = await screen.findByLabelText(/^Prepare worktree/)
    expect(prepare).toHaveValue('pnpm i')
    // The stored value is synced to the daemon on load instead of being fetched from it.
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/repo-prepare-commands?root='), expect.anything())
    expect(fetch).toHaveBeenCalledWith('/api/repo-prepare-commands', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ root: MAIN, command: 'pnpm i' }) }))
    fireEvent.change(prepare, { target: { value: 'pnpm build' } })
    expect(fetch).toHaveBeenLastCalledWith('/api/repo-prepare-commands', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ root: MAIN, command: 'pnpm build' }) }))
    fireEvent.change(prepare, { target: { value: '' } })
    expect(fetch).toHaveBeenLastCalledWith('/api/repo-prepare-commands', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ root: MAIN, command: '' }) }))
    expect(window.localStorage.getItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY)).toBeNull()
  })
  it('migrates every stored prepare command to the daemon once, without the dialog open', async () => {
    window.localStorage.setItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY, JSON.stringify({ '/repos/other-migrated': 'make setup', '/repos/blank-migrated': '  ' }))
    const { unmount } = render(<TmuxCreateControls token="migrate" onCreateSession={vi.fn()} />)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/repo-prepare-commands', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ root: '/repos/other-migrated', command: 'make setup' }) })))
    expect(fetch).not.toHaveBeenCalledWith('/api/repo-prepare-commands', expect.objectContaining({ body: expect.stringContaining('blank-migrated') }))
    unmount()
    vi.mocked(fetch).mockClear()
    render(<TmuxCreateControls token="migrate" onCreateSession={vi.fn()} />)
    await act(async () => {})
    expect(fetch).not.toHaveBeenCalledWith('/api/repo-prepare-commands', expect.objectContaining({ method: 'PUT' }))
  })
  it('retries a prepare-command migration that failed on the next mount', async () => {
    window.localStorage.setItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY, JSON.stringify({ '/repos/retry-migrated': 'make deps' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetch).mockRejectedValueOnce(new Error('daemon restarting'))
    const { unmount } = render(<TmuxCreateControls token="retry" onCreateSession={vi.fn()} />)
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith('Unable to sync repository prepare command', expect.any(Error)))
    unmount()
    vi.mocked(fetch).mockClear()
    render(<TmuxCreateControls token="retry" onCreateSession={vi.fn()} />)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/repo-prepare-commands', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ root: '/repos/retry-migrated', command: 'make deps' }) })))
  })

  it('does not overwrite edits with a delayed daemon prefill', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    render(<TmuxCreateControls variant="dialog" sessionCreateRequest={request} onCreateSession={vi.fn()} />)
    const prepare = await screen.findByLabelText(/^Prepare worktree/)
    fireEvent.change(prepare, { target: { value: 'my edit' } })
    await act(async () => resolve(new Response(JSON.stringify({ command: 'old daemon value' }))))
    expect(prepare).toHaveValue('my edit')
  })
  it('ignores stale prefills after the dialog changes repositories', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
      .mockImplementation(async () => new Response(JSON.stringify({ command: 'new repo' })))
    const { rerender } = render(<TmuxCreateControls variant="dialog" sessionCreateRequest={request} onCreateSession={vi.fn()} />)
    rerender(<TmuxCreateControls variant="dialog" sessionCreateRequest={{ ...request, id: 2, repo: { root: '/another', name: 'Other' } }} onCreateSession={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText(/^Prepare worktree/)).toHaveValue('new repo'))
    await act(async () => resolve(new Response(JSON.stringify({ command: 'old repo' }))))
    expect(screen.getByLabelText(/^Prepare worktree/)).toHaveValue('new repo')
  })
  it('warns on GET and PUT failures without blocking creation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const onCreateSession = vi.fn().mockResolvedValue({ created })
    render(<TmuxCreateControls variant="dialog" sessionCreateRequest={request} onCreateSession={onCreateSession} />)
    await waitFor(() => expect(warn).toHaveBeenCalledWith('Unable to load repository prepare command', expect.any(Error)))
    fireEvent.change(screen.getByLabelText(/^Prepare worktree/), { target: { value: 'npm ci' } })
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'next' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(warn).toHaveBeenCalledWith('Unable to sync repository prepare command', expect.any(Error))
  })
})
