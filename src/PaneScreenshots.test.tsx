// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PaneScreenshotFolder } from '../shared/protocol'
import { PaneScreenshotLightbox } from './PaneScreenshotLightbox'
import { PaneScreenshots } from './PaneScreenshots'

const folder: PaneScreenshotFolder = {
  id: '0123456789abcdef',
  dir: '/tmp/project/.screenshots/polish',
  topic: 'polish',
  imageCount: 6,
  otherCount: 1,
  bytes: 2_048,
  updatedAt: 100,
  preview: [
    { name: 'round-one.png', size: 100, modifiedAt: 200 },
    { name: 'round-two.png', size: 200, modifiedAt: 150 },
  ],
}

const listing = { ...folder, files: folder.preview }

afterEach(() => cleanup())

describe('PaneScreenshots', () => {
  it('renders the approved grid and opens images or the full folder', async () => {
    const onOpen = vi.fn()
    const onSeen = vi.fn()
    const revealPaneScreenshot = vi.fn().mockResolvedValue(undefined)
    render(
      <PaneScreenshots
        paneId="%1"
        folders={[folder]}
        collapsed={false}
        seenAt={175}
        screenshotsApi={{ list: vi.fn().mockResolvedValue(listing) }}
        paneManagementApi={{ revealPaneScreenshot }}
        onCollapsedChange={vi.fn()}
        onSeen={onSeen}
        onOpen={onOpen}
      />,
    )

    expect(screen.getByRole('region', { name: 'Screenshots for pane %1' })).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open screenshot round-one.png' }))
    expect(onOpen).toHaveBeenCalledWith(folder, 'round-one.png', expect.any(HTMLElement))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal polish in Finder' }))
    expect(revealPaneScreenshot).toHaveBeenCalledWith('%1', folder.id)
    expect(onSeen).toHaveBeenCalled()
  })
})

describe('PaneScreenshotLightbox', () => {
  it('cycles with the keyboard, reveals the current file, and restores focus on close', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    const revealPaneScreenshot = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1 })
    render(
      <PaneScreenshotLightbox
        request={{ paneId: '%1', folder, file: 'round-one.png', restoreFocus: trigger }}
        screenshotsApi={{ list: vi.fn().mockResolvedValue(listing) }}
        paneManagementApi={{ revealPaneScreenshot }}
        onClose={onClose}
      />,
    )

    expect(await screen.findByAltText('round-one.png')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await screen.findByAltText('round-two.png')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Reveal in Finder/i }))
    expect(revealPaneScreenshot).toHaveBeenCalledWith('%1', folder.id, 'round-two.png')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
