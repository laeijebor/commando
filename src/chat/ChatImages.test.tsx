// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageStrip } from './ChatImages'

afterEach(cleanup)

describe('ImageStrip', () => {
  const imageId = `${'a'.repeat(64)}.png`
  const videoId = `${'e'.repeat(64)}.mov`

  it('shows a video with a play mark and plays it in the viewer', () => {
    const { container } = render(<ImageStrip images={[{ id: imageId, name: 'pane.png' }, { id: videoId, name: 'clip.mov' }]} />)
    expect(screen.getByRole('button', { name: 'Open pane.png' })).toBeInTheDocument()
    expect(container.querySelector('video')?.getAttribute('src')).toBe(`/chat-images/${videoId}#t=0.1`)
    fireEvent.click(screen.getByRole('button', { name: 'Play clip.mov' }))
    const player = screen.getByLabelText('clip.mov', { selector: 'video' })
    expect(player.getAttribute('src')).toBe(`/chat-images/${videoId}`)
    expect(player.hasAttribute('controls')).toBe(true)
    expect(screen.getByRole('button', { name: 'Close video' })).toBeInTheDocument()
  })

  it('keeps a plain tile for a video the browser cannot draw', () => {
    const { container } = render(<ImageStrip images={[{ id: videoId, name: 'clip.mov' }]} />)
    fireEvent.error(container.querySelector('video')!)
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByRole('button', { name: 'Play clip.mov' })).toBeInTheDocument()
  })
})
