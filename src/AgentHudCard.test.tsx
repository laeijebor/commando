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
      />,
    )

    expect(container.querySelector('.agent-recap.recap-done')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeVisible()
    expect(screen.getByText('Delivered the activity-first HUD and focused tests.')).toBeVisible()
    expect(screen.getByText('2m ago')).toBeVisible()
  })

  it('renders compact progress, change, and check chips', () => {
    render(
      <AgentHudCard
        status={status({
          details: {
            recentActivities: [],
            progress: { completed: 3, total: 5, active: 'Run verification' },
            changes: {
              files: ['src/App.tsx', 'src/styles.css', 'src/AgentHudCard.tsx', 'src/AgentHudCard.test.tsx'],
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
      />,
    )

    expect(screen.getByText('3/5 tasks')).toBeVisible()
    expect(screen.getByText('4 files +12/-3')).toBeVisible()
    expect(screen.getByText('Tests passed')).toBeVisible()
    expect(screen.getByText('Typecheck failed')).toBeVisible()
  })

  it('keeps legacy statuses informative and clickable without details', () => {
    const onSelect = vi.fn()
    render(
      <AgentHudCard
        status={status()}
        windowName="terminal"
        paneIndex={4}
        now={NOW}
        onSelect={onSelect}
      />,
    )

    const card = screen.getByRole('button', { name: /Open claude agent in pane 4: Modernizing dashboard/ })
    expect(card).toHaveAttribute('type', 'button')
    expect(screen.getByText('Modernizing dashboard')).toBeVisible()
    expect(screen.getByText(/terminal \/ pane 4 \/ updated 5m ago/)).toBeVisible()
    expect(screen.getByText(/Source: hook \/ Confidence: high/)).toBeVisible()

    fireEvent.click(card)
    expect(onSelect).toHaveBeenCalledOnce()
  })
})
