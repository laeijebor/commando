// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentStatus } from '../shared/protocol'
import { AgentHudCard } from './AgentHudCard'

const NOW = new Date('2026-07-16T12:00:00Z').getTime()

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    paneId: '%4',
    provider: 'claude',
    status: 'working',
    summary: 'Modernizing dashboard',
    source: 'hook',
    confidence: 'high',
    reason: 'Agent hook emitted a working state',
    updatedAt: NOW - 300_000,
    ...overrides,
  }
}

afterEach(cleanup)

describe('AgentHudCard', () => {
  it('prioritizes intent and current activity while limiting recent activity labels', () => {
    render(
      <AgentHudCard
        status={status({
          details: {
            intent: 'Ship authentication flow',
            currentActivity: {
              label: 'Editing AuthGate.tsx',
              kind: 'edit',
              state: 'running',
              updatedAt: NOW - 10_000,
            },
            recentActivities: [
              { label: 'Inspected auth client', kind: 'inspect', state: 'completed', updatedAt: NOW - 60_000 },
              { label: 'Updated validation', kind: 'edit', state: 'completed', updatedAt: NOW - 120_000 },
              { label: 'Read old migration', kind: 'inspect', state: 'completed', updatedAt: NOW - 180_000 },
            ],
            checks: [],
          },
        })}
        windowName="web"
        paneIndex={2}
        now={NOW}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('Ship authentication flow')).toBeVisible()
    expect(screen.getByText('Editing AuthGate.tsx')).toBeVisible()
    expect(screen.getByText('Now')).toBeVisible()
    expect(screen.getByText('Inspected auth client')).toBeVisible()
    expect(screen.getByText('Updated validation')).toBeVisible()
    expect(screen.queryByText('Read old migration')).not.toBeInTheDocument()
  })

  it('renders attention before the rest of the task details', () => {
    render(
      <AgentHudCard
        status={status({
          status: 'needs_input',
          details: {
            attention: 'Approve the production migration',
            intent: 'Deploy the API',
            recentActivities: [],
            checks: [],
          },
        })}
        now={NOW}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    const attention = screen.getByText('Approve the production migration')
    const intent = screen.getByText('Deploy the API')
    expect(attention).toBeVisible()
    expect(attention.compareDocumentPosition(intent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows a stopped agent recap with its outcome and summary', () => {
    const { container } = render(
      <AgentHudCard
        status={status({
          status: 'done',
          details: {
            intent: 'Improve Agent HUD',
            recentActivities: [],
            checks: [],
            recap: {
              outcome: 'done',
              summary: 'Delivered the activity-first HUD and focused tests.',
              completedAt: NOW - 120_000,
            },
          },
        })}
        now={NOW}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(container.querySelector('.agent-recap.recap-done')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeVisible()
    expect(screen.getByText('Delivered the activity-first HUD and focused tests.')).toBeVisible()
    expect(screen.getByText('2m ago')).toBeVisible()
    const intent = screen.getByText('Improve Agent HUD')
    const recap = screen.getByText('Delivered the activity-first HUD and focused tests.')
    expect(intent.compareDocumentPosition(recap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders compact progress, change, and check chips', () => {
    render(
      <AgentHudCard
        status={status({
          details: {
            recentActivities: [],
            progress: { completed: 3, total: 5, active: 'Run verification' },
            changes: {
              fileCount: 4,
              additions: 12,
              deletions: 3,
            },
            checks: [
              { label: 'Tests', status: 'passed', updatedAt: NOW - 20_000 },
              { label: 'Typecheck', status: 'failed', updatedAt: NOW - 10_000 },
            ],
          },
        })}
        now={NOW}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('3/5 tasks')).toBeVisible()
    expect(screen.getByText('4 files +12/-3')).toBeVisible()
    expect(screen.getByText('Tests passed')).toBeVisible()
    expect(screen.getByText('Typecheck failed')).toBeVisible()
    expect(screen.getByRole('button', { name: /Open claude agent/ })).toHaveAccessibleName(
      /Progress: 3 of 5 tasks, active: Run verification.*Changes: 4 files, 12 additions, 3 deletions.*Check Tests: passed.*Check Typecheck: failed/,
    )
  })

  it('keeps legacy statuses informative and clickable without details', () => {
    const onSelect = vi.fn()
    const onDismiss = vi.fn()
    render(
      <AgentHudCard
        status={status()}
        sessionName="commando"
        windowName="terminal"
        paneIndex={4}
        now={NOW}
        onSelect={onSelect}
        onDismiss={onDismiss}
      />,
    )

    const card = screen.getByRole('button', { name: /Open claude agent in pane 4.*Modernizing dashboard/ })
    expect(card).toHaveAttribute('type', 'button')
    expect(card).toHaveAccessibleName(/Session: commando.*Window: terminal/)
    expect(card).toHaveAccessibleName(/Source: hook, confidence: high.*Agent hook emitted a working state/)
    expect(screen.getByText('Modernizing dashboard')).toBeVisible()
    expect(screen.getByText(/terminal \/ pane 4 \/ updated 5m ago/)).toBeVisible()
    expect(screen.queryByText(/Source: hook \/ Confidence: high/)).not.toBeInTheDocument()

    fireEvent.click(card)
    expect(onSelect).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss claude update for commando until its next update' }))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('uses the session as the visible title and hides synthetic task notification markup', () => {
    render(
      <AgentHudCard
        status={status({
          summary: '<task-notification><task-id>abc</task-id></task-notification>',
          details: {
            intent: '<task-notification><task-id>abc</task-id><output-file>/tmp/result</output-file></task-notification>',
            recentActivities: [],
            checks: [],
          },
        })}
        sessionName="gizmo-Save-All"
        now={NOW}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('gizmo-Save-All')).toBeVisible()
    expect(screen.queryByText(/task-notification/)).not.toBeInTheDocument()
    expect(screen.queryByText(/output-file/)).not.toBeInTheDocument()
    expect(screen.getByText('Agent hook emitted a working state')).toBeVisible()
  })
})
