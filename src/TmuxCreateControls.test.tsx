// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxCreatedTarget } from '../shared/tmux-create'
import { TMUX_CWD_HISTORY_STORAGE_KEY, TmuxCreateControls } from './TmuxCreateControls'

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

const options = {
  sessions: [{ id: '$1', name: 'work' }],
  windows: [{ id: '@2', name: 'editor', sessionId: '$1', index: 0 }],
  panes: [{ id: '%3', title: 'shell', windowId: '@2', index: 0 }],
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('TmuxCreateControls', () => {
  it('submits session fields and exposes pending and success states', async () => {
    let resolveCreate: ((value: TmuxCreatedTarget) => void) | undefined
    const onCreateSession = vi.fn(
      () =>
        new Promise<TmuxCreatedTarget>((resolve) => {
          resolveCreate = resolve
        }),
    )
    const onCreated = vi.fn()
    render(
      <TmuxCreateControls
        {...options}
        onCreateSession={onCreateSession}
        onCreateWindow={vi.fn()}
        onCreatePane={vi.fn()}
        onCreated={onCreated}
      />,
    )

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

    resolveCreate?.(created)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Created session %3 in work',
    )
    expect(onCreated).toHaveBeenCalledWith(created)
    expect(JSON.parse(window.localStorage.getItem(TMUX_CWD_HISTORY_STORAGE_KEY) ?? 'null')).toEqual([
      '/Users/dev/project',
    ])
    expect(screen.getByLabelText(/Working directory/)).toHaveValue('/Users/dev/project')
  })

  it('restores the last successfully used working directory', () => {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, '/Users/dev/remembered')

    render(
      <TmuxCreateControls
        {...options}
        onCreateSession={vi.fn()}
        onCreateWindow={vi.fn()}
        onCreatePane={vi.fn()}
      />,
    )

    expect(screen.getByLabelText(/Working directory/)).toHaveValue('/Users/dev/remembered')
  })

  it('filters recent directories and supports mouse and keyboard selection', () => {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, JSON.stringify([
      '/Users/dev/bravo',
      '/tmp/project',
      '/Users/dev/beta',
    ]))

    render(
      <TmuxCreateControls
        {...options}
        onCreateSession={vi.fn()}
        onCreateWindow={vi.fn()}
        onCreatePane={vi.fn()}
      />,
    )

    const input = screen.getByRole('combobox', { name: /Working directory/ })
    fireEvent.focus(input)
    expect(screen.getByRole('listbox', { name: 'Recent working directories' })).toBeInTheDocument()
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
    render(
      <TmuxCreateControls
        {...options}
        onCreateSession={vi.fn(async () => created)}
        onCreateWindow={vi.fn()}
        onCreatePane={vi.fn()}
      />,
    )

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
    render(
      <TmuxCreateControls
        {...options}
        onCreateSession={vi.fn(async () => created)}
        onCreateWindow={vi.fn()}
        onCreatePane={vi.fn()}
      />,
    )

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
        {...options}
        onCreateSession={vi.fn(async () => {
          throw new Error('session already exists')
        })}
        onCreateWindow={vi.fn()}
        onCreatePane={vi.fn()}
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

  it('uses stable pane targets and explicit split direction', async () => {
    const onCreatePane = vi.fn(async () => ({ ...created, kind: 'pane' as const }))
    render(
      <TmuxCreateControls
        {...options}
        initialMode="pane"
        defaultTargetId="%3"
        onCreateSession={vi.fn()}
        onCreateWindow={vi.fn()}
        onCreatePane={onCreatePane}
      />,
    )

    fireEvent.click(screen.getByLabelText('Stacked'))
    fireEvent.click(screen.getByRole('button', { name: 'Create split' }))

    await waitFor(() => {
      expect(onCreatePane).toHaveBeenCalledWith({
        targetId: '%3',
        direction: 'vertical',
        cwd: '',
      })
    })
  })
})
