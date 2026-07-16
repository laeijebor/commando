// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { PortsSection } from './PortsSection'

afterEach(cleanup)

describe('PortsSection', () => {
  it('groups sorted port links under their session names', () => {
    render(
      <PortsSection
        sessions={[
          { id: '$1', name: 'frontend', attached: true, activeWindowId: null, windowIds: [] },
          { id: '$2', name: 'api', attached: false, activeWindowId: null, windowIds: [] },
        ]}
        ports={[
          { port: 5173, processName: 'node', sessionId: '$1', paneId: '%1' },
          { port: 3000, processName: 'node', sessionId: '$1', paneId: '%2' },
          { port: 8787, processName: 'workerd', sessionId: '$2', paneId: '%3' },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Ports' })).toBeVisible()
    expect(screen.getByText('3')).toBeVisible()
    expect(within(screen.getByLabelText('Open ports for frontend')).getAllByRole('link').map((link) => link.textContent)).toEqual(['3000', '5173'])
    expect(within(screen.getByLabelText('Open ports for api')).getAllByRole('link').map((link) => link.textContent)).toEqual(['8787'])
    expect(screen.getByRole('link', { name: 'Open node on port 3000' })).toHaveAttribute('href', 'http://localhost:3000/')
    expect(screen.getByRole('link', { name: 'Open workerd on port 8787' })).toHaveAttribute('target', '_blank')
  })

  it('minimizes and reopens the grouped port links', () => {
    render(
      <PortsSection
        sessions={[{ id: '$1', name: 'frontend', attached: true, activeWindowId: null, windowIds: [] }]}
        ports={[{ port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' }]}
      />,
    )

    const minimize = screen.getByRole('button', { name: 'Minimize ports section' })
    expect(minimize).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(minimize)

    const reopen = screen.getByRole('button', { name: 'Reopen ports section' })
    expect(reopen).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'Open node on port 3000' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ports' })).toBeVisible()
    expect(screen.getByText('1')).toBeVisible()

    fireEvent.click(reopen)
    expect(screen.getByRole('link', { name: 'Open node on port 3000' })).toBeVisible()
  })

  it('stays hidden when no session owns an open port', () => {
    const { container } = render(
      <PortsSection
        sessions={[]}
        ports={[{ port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' }]}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
