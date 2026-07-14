// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearBoard, LinearIssue, LinearState } from './linearApi'
import { LinearSection } from './LinearSection'

const todo: LinearState = {
  id: 'todo',
  name: 'Todo',
  type: 'unstarted',
  color: '#888888',
  position: 1,
  teamId: 'team-1',
  teamName: 'Team',
}
const started: LinearState = {
  ...todo,
  id: 'started',
  name: 'In Progress',
  type: 'started',
  position: 2,
}
const issue: LinearIssue = {
  id: 'issue-1',
  identifier: 'VIV-1',
  title: 'Ship polling',
  priority: 2,
  priorityLabel: 'High',
  estimate: null,
  dueDate: null,
  updatedAt: '2026-07-11T00:00:00.000Z',
  url: 'https://linear.app/issue/VIV-1',
  assignee: null,
  state: todo,
  teamId: 'team-1',
  teamName: 'Team',
  labels: [],
}
const board: LinearBoard = {
  project: {
    id: 'project-1',
    name: 'Project',
    description: '',
    color: '#888888',
    icon: null,
    progress: 0,
    state: 'started',
    targetDate: null,
    url: 'https://linear.app/team/project/project-1',
  },
  states: [todo, started],
  issues: [issue],
  truncated: false,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('LinearSection', () => {
  it('copies the project link to the clipboard', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/linear/accounts')) {
        return Response.json({ accounts: [{ id: 'account-1', label: 'Work', workspaceName: 'Work', viewerName: 'Ada', createdAt: 1 }] })
      }
      if (url.endsWith('/projects')) {
        return Response.json({ projects: [board.project], truncated: false })
      }
      if (url.endsWith('/board')) return Response.json({ board })
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<LinearSection token="test-token" />)
    const copyButton = await screen.findByRole('button', { name: 'Copy project link' })

    fireEvent.click(copyButton)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://linear.app/team/project/project-1'))
  })

  it('optimistically moves an issue when it is dropped on a same-team status', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/linear/accounts')) {
        return Response.json({ accounts: [{ id: 'account-1', label: 'Work', workspaceName: 'Work', viewerName: 'Ada', createdAt: 1 }] })
      }
      if (url.endsWith('/projects')) {
        return Response.json({ projects: [board.project], truncated: false })
      }
      if (url.endsWith('/board')) return Response.json({ board })
      if (url.endsWith('/state') && init?.method === 'PATCH') {
        return Response.json({ issue: { ...issue, state: started } })
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 })
    })

    render(<LinearSection token="test-token" />)
    const card = await screen.findByRole('button', { name: /VIV-1.*Ship polling/ })
    expect(screen.getByText('Live / 30s')).toBeVisible()
    expect(card.querySelector('.linear-priority.priority-2 svg')).not.toBeNull()
    expect(within(card).getByText('High')).toBeVisible()
    const target = screen.getByText('In Progress').closest<HTMLElement>('.linear-column')
    expect(target).not.toBeNull()
    const transfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => 'issue-1'),
    }

    fireEvent.dragStart(card, { dataTransfer: transfer })
    fireEvent.dragOver(target!, { dataTransfer: transfer })
    fireEvent.drop(target!, { dataTransfer: transfer })

    await waitFor(() => {
      expect(within(target!).getByRole('button', { name: /VIV-1.*Ship polling/ })).toBeVisible()
      expect(fetcher).toHaveBeenCalledWith(
        '/api/linear/accounts/account-1/issues/issue-1/state',
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
  })
})
