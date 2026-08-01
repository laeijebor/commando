// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortsSection } from './PortsSection'

const portApi = vi.hoisted(() => ({
  killPort: vi.fn(),
  killSessionPorts: vi.fn(),
}))

vi.mock('./portManagementApi', () => ({ createPortManagementApi: () => portApi }))

const navigationProps = {
  selectedSessionId: null,
  onSelectSession: vi.fn(),
  onSelectPane: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  portApi.killPort.mockResolvedValue(undefined)
  portApi.killSessionPorts.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PortsSection', () => {
  it('groups sorted port links under their session names', () => {
    render(
      <PortsSection
        {...navigationProps}
        selectedSessionId="$1"
        token="token"
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
    expect(screen.getByRole('link', { name: 'Focus pane for node on port 3000 and open service' })).toHaveAttribute('href', 'http://localhost:3000/')
    expect(screen.getByRole('link', { name: 'Focus pane for workerd on port 8787 and open service' })).toHaveAttribute('target', '_blank')
  })

  it('focuses the owning session and pane while preserving port links', () => {
    render(
      <PortsSection
        {...navigationProps}
        selectedSessionId="$1"
        token="token"
        sessions={[{ id: '$1', name: 'frontend', attached: true, activeWindowId: null, windowIds: [] }]}
        ports={[{ port: 3000, processName: 'node', sessionId: '$1', paneId: '%2' }]}
      />,
    )

    const session = screen.getByRole('button', { name: 'Select session frontend' })
    expect(session).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(session)
    const port = screen.getByRole('link', { name: 'Focus pane for node on port 3000 and open service' })
    fireEvent.click(port)

    expect(navigationProps.onSelectSession).toHaveBeenCalledWith('$1')
    expect(navigationProps.onSelectPane).toHaveBeenCalledWith('%2')
    expect(port).toHaveAttribute('href', 'http://localhost:3000/')
    expect(port).toHaveAttribute('target', '_blank')
  })

  it('minimizes and reopens the grouped port links', () => {
    render(
      <PortsSection
        {...navigationProps}
        token="token"
        sessions={[{ id: '$1', name: 'frontend', attached: true, activeWindowId: null, windowIds: [] }]}
        ports={[{ port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' }]}
      />,
    )

    const minimize = screen.getByRole('button', { name: 'Minimize ports section' })
    expect(minimize).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(minimize)

    const reopen = screen.getByRole('button', { name: 'Reopen ports section' })
    expect(reopen).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('sidebar-port-groups')).toHaveAttribute('hidden')
    expect(screen.queryByRole('link', { name: 'Focus pane for node on port 3000 and open service' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ports' })).toBeVisible()
    expect(screen.getByText('1')).toBeVisible()

    fireEvent.click(reopen)
    expect(screen.getByRole('link', { name: 'Focus pane for node on port 3000 and open service' })).toBeVisible()
  })

  it('opens process actions only for Option-right-click and kills the current listener', async () => {
    const port = { port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' }
    render(
      <PortsSection
        {...navigationProps}
        token="token"
        sessions={[{ id: '$1', name: 'frontend', attached: true, activeWindowId: null, windowIds: [] }]}
        ports={[port]}
      />,
    )
    const link = screen.getByRole('link', { name: 'Focus pane for node on port 3000 and open service' })

    fireEvent.contextMenu(link, { clientX: 40, clientY: 50 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.contextMenu(link, { altKey: true, clientX: 40, clientY: 50 })
    expect(screen.getByRole('menu', { name: 'Port actions for 3000' })).toBeVisible()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Kill process' }))
    expect(portApi.killPort).toHaveBeenCalledWith(port)
  })

  it('confirms before killing all port processes for a session', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <PortsSection
        {...navigationProps}
        token="token"
        sessions={[{ id: '$1', name: 'frontend', attached: true, activeWindowId: null, windowIds: [] }]}
        ports={[
          { port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' },
          { port: 5173, processName: 'node', sessionId: '$1', paneId: '%1' },
        ]}
      />,
    )
    const killAll = screen.getByRole('button', { name: 'Kill all port processes for frontend' })

    fireEvent.click(killAll)
    expect(portApi.killSessionPorts).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(killAll)

    expect(confirm).toHaveBeenLastCalledWith('Kill every process listening on ports 3000, 5173 for "frontend"? This can stop development servers.')
    expect(portApi.killSessionPorts).toHaveBeenCalledWith('$1', [
      { port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' },
      { port: 5173, processName: 'node', sessionId: '$1', paneId: '%1' },
    ])
  })

  it('stays hidden when no session owns an open port', () => {
    const { container } = render(
      <PortsSection
        {...navigationProps}
        token="token"
        sessions={[]}
        ports={[{ port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' }]}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
