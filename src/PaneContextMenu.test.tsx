// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneContextMenu } from './PaneContextMenu'

afterEach(cleanup)

describe('PaneContextMenu', () => {
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
})
