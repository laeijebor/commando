// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxCreatedTarget } from '../shared/tmux-create'
import { TmuxCreateControls } from './TmuxCreateControls'

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

afterEach(cleanup)

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
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('session already exists')
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
