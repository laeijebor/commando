// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { PrBadges } from './PrBadges'
import type { PrStatus } from './prsApi'

afterEach(cleanup)

const status: PrStatus = {
  additions: 0, deletions: 0, checks: null, conflicting: false,
  unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
}

describe('PR comment pills', () => {
  it.each([
    { total: 0, unanswered: 0, labels: [] },
    { total: 3, unanswered: 3, labels: ['3 unanswered'] },
    { total: 3, unanswered: 0, labels: ['3 unresolved'] },
    { total: 3, unanswered: 2, labels: ['2 unanswered', '1 unresolved'] },
    { total: 3, unanswered: undefined, labels: ['3 unanswered'] },
  ])('renders the open-thread split $total/$unanswered', ({ total, unanswered, labels }) => {
    const { container } = render(<PrBadges number={12} pr={{
      ...status, unresolvedThreads: total, unansweredThreads: unanswered,
    }} />)
    expect([...container.querySelectorAll('.pr-chip.warn, .pr-chip.replied')].map((pill) => pill.textContent)).toEqual(labels)
    for (const label of labels) {
      expect(screen.getByText(label)).toHaveClass(label.endsWith('unanswered') ? 'warn' : 'replied')
    }
  })
})
