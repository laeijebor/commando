// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionBrief } from '../shared/protocol'
import { SessionUpdateCapsule } from './SessionUpdateCapsule'

afterEach(cleanup)

const brief: SessionBrief = {
  paneId: '%12',
  sessionId: '$1',
  sessionName: 'commando',
  state: 'done',
  headline: 'Footer capsule verified',
  headlineSource: 'agent',
  recapMarkdown: 'All **focused checks** passed.',
  updates: [
    {
      id: 'agent:1:test',
      paneId: '%12',
      kind: 'check',
      text: 'Typecheck and Vitest passed',
      detail: 'No regressions found',
      source: 'agent',
      createdAt: 100,
    },
  ],
  next: 'Review the dry-run screenshots',
  updatedAt: 100,
}

describe('SessionUpdateCapsule', () => {
  it('opens a native-safe pane brief from the compact footer trigger', () => {
    render(<SessionUpdateCapsule brief={brief} paneLabel="Tests" onSelectPane={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Open updates for Tests' })
    expect(trigger).toHaveTextContent('Footer capsule verified')
    expect(screen.queryByLabelText('Updates for Tests')).not.toBeInTheDocument()

    fireEvent.click(trigger)

    const sheet = screen.getByLabelText('Updates for Tests')
    expect(sheet).toHaveAttribute('data-native-terminal-occluder')
    expect(sheet).toHaveTextContent('All focused checks passed.')
    expect(sheet).toHaveTextContent('Review the dry-run screenshots')
  })

  it('navigates to a milestone source pane and closes the sheet', () => {
    const onSelectPane = vi.fn()
    render(<SessionUpdateCapsule brief={brief} paneLabel="Tests" onSelectPane={onSelectPane} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open updates for Tests' }))

    fireEvent.click(screen.getByRole('button', { name: /Typecheck and Vitest passed/ }))

    expect(onSelectPane).toHaveBeenCalledWith('%12')
    expect(screen.queryByLabelText('Updates for Tests')).not.toBeInTheDocument()
  })
})
