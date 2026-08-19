// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'

import type { SessionBrief } from '../shared/protocol'
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
