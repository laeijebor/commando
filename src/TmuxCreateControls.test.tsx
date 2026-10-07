// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateTmuxSessionRequest, GitRepoInfo, TmuxCreatedTarget, TmuxCreateResponse } from '../shared/tmux-create'
import {
  TMUX_CWD_HISTORY_STORAGE_KEY,
  TmuxCreateControls,
  WORKTREE_PREPARE_COMMANDS_STORAGE_KEY,
} from './TmuxCreateControls'

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

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('TmuxCreateControls', () => {
  it.each(['inline', 'dialog'] as const)('retains old-host partial creation in the %s form and opens it without a duplicate create', async (variant) => {
    const onCreateSession = vi.fn(async () => ({ created }))
    const onCreated = vi.fn()
    render(<TmuxCreateControls variant={variant} onCreateSession={onCreateSession} onCreated={onCreated} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'cursor' } })
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
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'cursor' } })
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
    expect(screen.getByLabelText('Start with')).toHaveValue('cursor')

    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'shell' } })
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
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'cursor' } })
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
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'cursor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await screen.findByRole('alert')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open created session %3' })))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created, 'ungrouped', undefined)
    expect(onCreateSession).toHaveBeenCalledOnce()
    expect(view.container).toBeEmptyDOMElement()
  })
  it.each(['inline', 'dialog'] as const)('creates Cursor interactively in the %s form while preserving Shell as the default', async (variant) => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, ...(input.agent ? { agentLaunch: { version: 1, provider: input.agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } } : {}) }))
    render(<TmuxCreateControls variant={variant} onCreateSession={onCreateSession} />)
    expect(screen.getByLabelText('Start with')).toHaveValue('shell')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'cursor' } })
    const prompt = "Read Leo's spec\nInspect $HOME `whoami`"
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: prompt } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith({ name: 'work', windowName: '', cwd: '', agent: { provider: 'cursor', prompt } }))
    expect(screen.getByLabelText('Start with')).toHaveValue('cursor')
    expect(screen.getByLabelText(/Opening prompt/)).toHaveValue('')
  })

  it('omits a retained opening prompt when switching to OpenCode or Shell', async () => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({ created, ...(input.agent ? { agentLaunch: { version: 1, provider: input.agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } } : {}) }))
    render(<TmuxCreateControls onCreateSession={onCreateSession} />)
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'cursor' } })
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: 'Read' } })
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'opencode' } })
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ agent: { provider: 'opencode' } })))
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'shell' } })
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

    fireEvent.click(screen.getByRole('button', { name: /Edit worktree path/ }))
    fireEvent.change(screen.getByLabelText(/Worktree path/), { target: { value: '/Users/dev/elsewhere/flow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenLastCalledWith(expect.objectContaining({
      worktree: { branch: 'flow', path: '/Users/dev/elsewhere/flow' },
    })))

    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'plain' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenLastCalledWith({ name: 'plain', windowName: '', cwd: MAIN }))
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
