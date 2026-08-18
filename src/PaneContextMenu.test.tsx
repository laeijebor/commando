// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneContextMenu } from './PaneContextMenu'

afterEach(cleanup)

describe('PaneContextMenu', () => {
  it('dismisses on an outside pointer press without dismissing inside the menu', () => {
    const onClose = vi.fn()
    const { container } = render(
      <PaneContextMenu
        paneLabel="api"
        x={50}
        y={60}
        onClose={onClose}
        onRename={vi.fn()}
        onSplit={vi.fn()}
        onKill={vi.fn()}
      />,
    )

    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(onClose).not.toHaveBeenCalled()

    const backdrop = container.querySelector('.pane-context-menu-backdrop')
    expect(backdrop).toHaveAttribute('data-native-terminal-occluder', '')
    fireEvent.pointerDown(backdrop!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each(['up', 'down', 'left', 'right'] as const)('selects the %s split direction', (direction) => {
    const onClose = vi.fn()
    const onSplit = vi.fn()
    render(
      <PaneContextMenu
        paneLabel="api"
        x={50}
        y={60}
        onClose={onClose}
        onRename={vi.fn()}
        onSplit={onSplit}
        onKill={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(direction, 'i') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onSplit).toHaveBeenCalledWith(direction)
  })

  it('supports rename, kill, and Escape dismissal', () => {
    const onClose = vi.fn()
    const onRename = vi.fn()
    const onKill = vi.fn()
    render(
      <PaneContextMenu
        paneLabel="worker"
        x={50}
        y={60}
        onClose={onClose}
        onRename={onRename}
        onSplit={vi.fn()}
        onKill={onKill}
      />,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Kill pane' }))
    expect(onKill).toHaveBeenCalledOnce()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('switches renderer locally even when daemon-backed actions are busy', () => {
    const onClose = vi.fn()
    const onUseXtermFallbackChange = vi.fn()
    const view = render(
      <PaneContextMenu
        paneLabel="worker"
        x={50}
        y={60}
        busy
        nativeTerminalAvailable
        onClose={onClose}
        onRename={vi.fn()}
        onSplit={vi.fn()}
        onUseXtermFallbackChange={onUseXtermFallbackChange}
        onKill={vi.fn()}
      />,
    )

    const fallback = screen.getByRole('menuitem', { name: 'Use xterm fallback' })
    expect(fallback).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDisabled()
    fireEvent.click(fallback)

    expect(onClose).toHaveBeenCalledOnce()
    expect(onUseXtermFallbackChange).toHaveBeenCalledWith(true)

    view.rerender(
      <PaneContextMenu
        paneLabel="worker"
        x={50}
        y={60}
        useXtermFallback
        onClose={onClose}
        onRename={vi.fn()}
        onSplit={vi.fn()}
        onUseXtermFallbackChange={onUseXtermFallbackChange}
        onKill={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use native terminal' }))
    expect(onUseXtermFallbackChange).toHaveBeenLastCalledWith(false)
  })

  it('hides the renderer action when no native host is available or overridden', () => {
    render(
      <PaneContextMenu
        paneLabel="worker"
        x={50}
        y={60}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onSplit={vi.fn()}
        onUseXtermFallbackChange={vi.fn()}
        onKill={vi.fn()}
      />,
    )

    expect(screen.queryByRole('menuitem', { name: /Use (?:xterm|native)/ })).not.toBeInTheDocument()
  })
})
